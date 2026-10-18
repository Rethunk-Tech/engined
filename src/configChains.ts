/** `[[chain]]`: parsing each table and resolving its hops against the routes that exist. */
import { chainHopRoutes, parseHop, routeForChainHop } from './chain.ts'
import { CHAIN_KEYS } from './configKeys.ts'
import { asArray, parseDisable, requireString, requireTable } from './configParse.ts'
import { engineHasWildcard } from './configRouteValidate.ts'
import { type ConfigPath, ParseError } from './errors/parse.ts'
import { qualifiedSegments, WILDCARD_MODEL } from './routeAddress.ts'
import type { EngineEntry, ResolvedRoute } from './types.ts'

/**
 * One chain's hops, minus any whose resolved (engine, upstream, model)
 * address is disabled -- through the engine, the upstream, or the route
 * itself. Split out of `parseChains` so each half is one job.
 */
function parseChainHops({
  name,
  hops,
  engines,
  routes,
  at,
  include,
}: {
  name: string
  hops: readonly string[]
  engines: readonly EngineEntry[]
  routes: readonly ResolvedRoute[]
  at: ConfigPath
  include: (id: string, hop: string, index: number) => string[]
}): string[] {
  const kept: string[] = []
  for (const [i, hop] of hops.entries()) {
    // A hop is a route address, or `@/<chain-id>`, which expands to that chain's hops.
    const segs = qualifiedSegments(hop)
    if (segs?.length === 1) {
      kept.push(...include(segs[0] as string, hop, i))
      continue
    }
    if (segs === undefined) {
      throw new ParseError(
        `chain "${name}"[${i}] "${hop}" is not a fully-qualified "@/<engine>/<model>" or "@/<engine>/<upstream>/<model>" hop`,
        { ...at, key: 'hops' },
      )
    }
    // `local` is a real upstream id, never an engine one: a hop names an
    // engine by its actual id, same as every other address form.
    const { engine: engineId, model, upstream } = parseHop(hop)
    if (!engines.some((e) => e.id === engineId)) {
      throw new ParseError(`chain hop "${hop}": engine "${engineId}" does not exist`, {
        ...at,
        key: 'hops',
      })
    }
    if (model === WILDCARD_MODEL) {
      throw new ParseError(
        `chain "${name}"[${i}] "${hop}": "${WILDCARD_MODEL}" is the wildcard sentinel, not a served address`,
        { ...at, key: 'hops' },
      )
    }
    const { candidates: declared, modelless } = chainHopRoutes(routes, hop)
    const route = routeForChainHop(routes, hop)
    if (route === undefined) {
      // A hop onto a disabled engine, upstream or route drops out rather than
      // failing parse: the point of disabling one is that the chains naming it
      // keep working on what is left. An address that names nothing at all,
      // or resolves to nothing served for any other reason, is still a parse
      // error.
      if (declared.length > 0 && declared.every((r) => r.disabled === true)) {
        continue
      }
      // Inventory is empty at boot: a hop onto a catalog id the operator has
      // not declared still parses when this engine+upstream carries a wildcard.
      // Dispatch refuses until the cache contains that wire id.
      if (!modelless && engineHasWildcard(routes, engineId, upstream)) {
        kept.push(hop)
        continue
      }
      throw new ParseError(
        modelless
          ? `chain "${name}"[${i}] "${hop}": "${engineId}" is modelless and has no route with upstream "${model}"`
          : `chain "${name}"[${i}] "${hop}": model "${model}" does not exist on "${engineId}"`,
        { ...at, key: 'hops' },
      )
    }
    kept.push(hop)
  }
  return kept
}

interface RawChain {
  id: string
  hops: string[]
  disabled: boolean
}

export function parseChainRaw(value: unknown, index: number, file: string): RawChain {
  const posSite = `chain[${index}]`
  const raw = requireTable(value, posSite, CHAIN_KEYS, file)
  const id = requireString(raw.id, `${posSite} "id"`, file)
  const site = `chain "${id}"`
  const hopsRaw = asArray(raw.hops, `${site} "hops"`, file)
  if (hopsRaw.length === 0) {
    throw new ParseError(`${site} has no hops`, { file, key: 'hops' })
  }
  const hops = hopsRaw.map((h, i) => requireString(h, `${site} "hops[${i}]"`, file))
  return { id, hops, disabled: parseDisable(raw, site, file) === true }
}

/**
 * Hop strings as written on a served chain, in order, including
 * `@/<chain-id>`. A list that was never parsed (a hand-built config) has
 * no separate writing, so the leaves are what was written.
 */
export function declaredHops(hops: readonly string[]): readonly string[] {
  if (!Object.hasOwn(hops, 'declared_hops')) {
    return hops
  }
  const value: unknown = (hops as unknown as { declared_hops: unknown }).declared_hops
  return Array.isArray(value) && value.every((hop) => typeof hop === 'string') ? value : hops
}

export function buildChains(
  rawChains: readonly RawChain[],
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  chainFiles: readonly string[],
  chainIndexes: readonly number[],
): Record<string, string[]> {
  const located = new Map(rawChains.map((chain, n) => [chain.id, n]))
  const done = new Map<string, string[]>()
  const stack: string[] = []

  const expand = (name: string): string[] => {
    const hit = done.get(name)
    if (hit !== undefined) {
      return hit
    }
    const n = located.get(name)
    const chain = n === undefined ? undefined : rawChains[n]
    // A disabled chain contributes nothing, same as a disabled route hop.
    if (n === undefined || chain === undefined || chain.disabled) {
      done.set(name, [])
      return []
    }
    const at = {
      file: chainFiles[n] as string,
      table: 'chain',
      index: chainIndexes[n] as number,
    }
    stack.push(name)
    const hops = parseChainHops({
      name,
      hops: chain.hops,
      engines,
      routes,
      at,
      include: (id, hop, i) => {
        if (!located.has(id)) {
          throw new ParseError(`chain "${name}"[${i}] "${hop}": "${id}" is not a chain`, {
            ...at,
            key: 'hops',
          })
        }
        const cycleAt = stack.indexOf(id)
        if (cycleAt !== -1) {
          const via = [...stack.slice(cycleAt), id].join(' -> ')
          throw new ParseError(
            `chain "${name}"[${i}] "${hop}": chain "${id}" includes itself (${via})`,
            {
              ...at,
              key: 'hops',
            },
          )
        }
        return expand(id)
      },
    })
    stack.pop()
    // The array is the expanded leaves dispatch walks. The strings the
    // operator wrote, including `@/<chain-id>`, stay on it so the models
    // menu can show a nested hop without making runtime walk one again.
    // Non-enumerable: equality and any key walk of the array still see
    // only the leaves.
    Object.defineProperty(hops, 'declared_hops', {
      value: [...chain.hops],
      enumerable: false,
    })
    done.set(name, hops)
    return hops
  }

  const chains: Record<string, string[]> = Object.create(null)
  for (const c of rawChains) {
    // A disabled chain is not served at all -- its own top-level flag, not a
    // resolved-hop question the way an engine/upstream/route's is.
    if (c.disabled) {
      continue
    }
    const hops = expand(c.id)
    // Nothing left to route to: the chain goes with its hops rather than
    // resolving to an empty list a request would fall off the end of.
    if (hops.length > 0) {
      chains[c.id] = hops
    }
  }
  return chains
}
