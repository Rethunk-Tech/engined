/** Deleting an entry other entries point at: turning the server's dependents list into the ops that remove those references too. */
import type { EditOp } from '../../editOps.ts'
import type { Doc } from './model.ts'

const PATH_RE = /^(\w+)\[(\d+)\](?:\.(\w+)(?:\[(\d+)\])?)?$/

interface Ref {
  table: string
  index: number
  key?: string
  hop?: number
}

function parse(dep: string): Ref | undefined {
  const m = PATH_RE.exec(dep)
  if (m === null) {
    return undefined
  }
  return {
    table: m[1] as string,
    index: Number(m[2]),
    key: m[3],
    hop: m[4] === undefined ? undefined : Number(m[4]),
  }
}

const descending = (a: number, b: number) => b - a

/**
 * The ops that clear every reference in `deps` without leaving a half-valid entry. A route that
 * names the removed id as its engine, upstream or model is removed; a loose address field or a
 * default model is unset; a chain loses the hop, and goes itself when no hop is left. Key edits
 * come first so the indexes they use still hold; removals run from the highest index down.
 */
export function removalOps(doc: Doc, deps: readonly string[]): EditOp[] {
  const refs = deps.flatMap((d) => parse(d) ?? [])
  const dropRoutes = new Set<number>()
  const dropChains = new Set<number>()
  const sets: EditOp[] = []
  const hopsLeft = new Map<number, string[]>()
  for (const ref of refs) {
    if (ref.table === 'route' && ['engine', 'upstream', 'model'].includes(ref.key ?? '')) {
      dropRoutes.add(ref.index)
    }
  }
  for (const ref of refs) {
    if (ref.table === 'route' && !dropRoutes.has(ref.index) && ref.key !== undefined) {
      sets.push({ op: 'setKey', path: ['route', ref.index, ref.key], value: undefined })
    } else if (ref.table === 'engine' && ref.key !== undefined) {
      sets.push({ op: 'setKey', path: ['engine', ref.index, ref.key], value: undefined })
    } else if (ref.table === 'chain' && ref.hop !== undefined) {
      const hops = hopsLeft.get(ref.index) ?? [
        ...((doc.chain[ref.index]?.hops as string[] | undefined) ?? []),
      ]
      hops[ref.hop] = '\0'
      hopsLeft.set(ref.index, hops)
    }
  }
  for (const [index, hops] of hopsLeft) {
    const kept = hops.filter((h) => h !== '\0')
    if (kept.length === 0) {
      dropChains.add(index)
    } else {
      sets.push({ op: 'setKey', path: ['chain', index, 'hops'], value: kept })
    }
  }
  return [
    ...sets,
    ...[...dropRoutes]
      .sort(descending)
      .map((index): EditOp => ({ op: 'removeEntry', table: 'route', index })),
    ...[...dropChains]
      .sort(descending)
      .map((index): EditOp => ({ op: 'removeEntry', table: 'chain', index })),
  ]
}
