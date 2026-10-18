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

/** `dropped` is a hop whose every candidate route is disabled, or a hop onto a disabled chain. */
export function hopState(doc: Doc, hop: string, upstreamOf: UpstreamOf): HopState {
  const seg = qualifiedSegments(hop)
  if (seg?.length === 1) {
    const chain = doc.chain.find((c) => c.id === seg[0])
    if (chain === undefined) {
      return 'unresolved'
    }
    return chain.disable === true ? 'dropped' : 'ok'
  }
  const found = candidates(doc, hop, upstreamOf)
  if (found.length === 0) {
    return 'unresolved'
  }
  return found.every((r) => routeOff(doc, r, upstreamOf)) ? 'dropped' : 'ok'
}

export type ChainPreview = { kind: 'leaves'; addresses: string[] } | { kind: 'cycle'; text: string }

const chainIdOf = (hop: string): string | undefined => {
  const seg = qualifiedSegments(hop)
  return seg?.length === 1 ? seg[0] : undefined
}

const chainNamed = (doc: Doc, id: string): Table | undefined => doc.chain.find((c) => c.id === id)

/**
 * Leaf addresses one chain inserts, in hop order. A disabled chain contributes
 * nothing. A hop back onto a chain already being walked is the same cycle text
 * parse raises (`includes itself`), so a loop in the draft stays one line.
 */
function expandChain(
  doc: Doc,
  id: string,
  upstreamOf: UpstreamOf,
  stack: readonly string[],
): ChainPreview {
  const cycleAt = stack.indexOf(id)
  if (cycleAt !== -1) {
    const via = [...stack.slice(cycleAt), id].join(' -> ')
    return { kind: 'cycle', text: `chain "${id}" includes itself (${via})` }
  }
  const chain = chainNamed(doc, id)
  if (chain === undefined || chain.disable === true) {
    return { kind: 'leaves', addresses: [] }
  }
  const next = [...stack, id]
  const addresses: string[] = []
  const hops = Array.isArray(chain.hops) ? chain.hops : []
  for (const hop of hops) {
    if (typeof hop !== 'string') {
      continue
    }
    const nested = chainIdOf(hop)
    if (nested !== undefined) {
      if (chainNamed(doc, nested) === undefined) {
        addresses.push(hop)
        continue
      }
      const inner = expandChain(doc, nested, upstreamOf, next)
      if (inner.kind === 'cycle') {
        return inner
      }
      addresses.push(...inner.addresses)
      continue
    }
    if (hopState(doc, hop, upstreamOf) === 'dropped') {
      continue
    }
    addresses.push(hop)
  }
  return { kind: 'leaves', addresses }
}

/**
 * Path `editing -> … -> editing` when chain `id` reaches `editing`, so adding it
 * as a hop would close a cycle. A disabled chain is not walked: parse drops it
 * and it cannot close one. A loop that never returns to `editing` is not this
 * path. Absent when the hop is safe.
 */
export function closingCycle(doc: Doc, editing: string, id: string): string | undefined {
  const walk = (at: string, stack: readonly string[]): string | undefined => {
    if (at === editing) {
      return [...stack, at].join(' -> ')
    }
    // Already on this path through some other loop. Stop, and keep searching.
    if (stack.includes(at)) {
      return undefined
    }
    const chain = chainNamed(doc, at)
    if (chain === undefined || chain.disable === true) {
      return undefined
    }
    const next = [...stack, at]
    const hops = Array.isArray(chain.hops) ? chain.hops : []
    for (const hop of hops) {
      if (typeof hop !== 'string') {
        continue
      }
      const nested = chainIdOf(hop)
      if (nested === undefined || chainNamed(doc, nested) === undefined) {
        continue
      }
      const hit = walk(nested, next)
      if (hit !== undefined) {
        return hit
      }
    }
    return undefined
  }
  return walk(id, [editing])
}

/** Chain addresses the picker must show but not offer, with the cycle path as the reason. */
export function blockedChainHops(doc: Doc, editing: string): ReadonlyMap<string, string> {
  const blocked = new Map<string, string>()
  for (const chain of doc.chain) {
    if (typeof chain.id !== 'string' || chain.id === editing) {
      continue
    }
    const path = closingCycle(doc, editing, chain.id)
    if (path !== undefined) {
      blocked.set(`@/${chain.id}`, path)
    }
  }
  return blocked
}

/**
 * What a `@/<chain-id>` hop inserts. Absent for a route hop, an unknown id, or
 * a disabled chain: those keep the hop note. The draft text is not rewritten.
 */
export function chainExpansion(
  doc: Doc,
  hop: string,
  upstreamOf: UpstreamOf,
): ChainPreview | undefined {
  const id = chainIdOf(hop)
  if (id === undefined) {
    return undefined
  }
  const chain = chainNamed(doc, id)
  if (chain === undefined || chain.disable === true) {
    return undefined
  }
  return expandChain(doc, id, upstreamOf, [])
}

/** The line under a chain hop: the leaves it inserts, or the cycle text. */
export function expansionText(preview: ChainPreview): string {
  if (preview.kind === 'cycle') {
    return preview.text
  }
  return preview.addresses.length === 0
    ? 'inserts nothing'
    : `inserts ${preview.addresses.join(', ')}`
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
 * Every address a hop can be chosen from: each declared route, each other enabled chain as
 * `@/<id>`, and each id in the cached catalog of an enabled wildcard route. A disabled
 * chain is omitted: parse drops a hop onto one, so offering it writes a line that vanishes
 * on save. A disabled route stays listed; the card flags it dropped. The wildcard itself
 * is a catalog, not one model to try. `except` is the chain being edited, so it is not
 * offered to itself. A chain that would close a cycle stays listed; the picker refuses
 * it (`blockedChainHops`).
 */
export function hopChoices(
  doc: Doc,
  upstreamOf: UpstreamOf,
  inventories: Record<string, unknown>,
  except?: string,
): string[] {
  const declared = addressBook(doc, upstreamOf)
    .filter(
      (row) =>
        (row.kind === 'route' && !row.address.endsWith('/*')) ||
        (row.kind === 'chain' && !row.disabled && row.address !== `@/${except}`),
    )
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
