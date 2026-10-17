/** `[[chain]]`: parsing each table and resolving its hops against the routes that exist. */
import { chainHopRoutes, parseHop, routeForChainHop } from './chain.ts'
import { asArray, CHAIN_KEYS, parseDisable, requireString, requireTable } from './configParse.ts'
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
}: {
  name: string
  hops: readonly string[]
  engines: readonly EngineEntry[]
  routes: readonly ResolvedRoute[]
  at: ConfigPath
}): string[] {
  const kept: string[] = []
  for (const [i, hop] of hops.entries()) {
    // `@/<engine>/<model>` and `@/<engine>/<upstream>/<model>` are the only hop shapes.
    const segs = qualifiedSegments(hop)
    if (segs === undefined || segs.length === 1) {
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

export function buildChains(
  rawChains: readonly RawChain[],
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  chainFiles: readonly string[],
  chainIndexes: readonly number[],
): Record<string, string[]> {
  const chains: Record<string, string[]> = Object.create(null)
  for (const [i, c] of rawChains.entries()) {
    // A disabled chain is not served at all -- its own top-level flag, not a
    // resolved-hop question the way an engine/upstream/route's is.
    if (c.disabled) {
      continue
    }
    const hops = parseChainHops({
      name: c.id,
      hops: c.hops,
      engines,
      routes,
      at: { file: chainFiles[i] as string, table: 'chain', index: chainIndexes[i] as number },
    })
    // Nothing left to route to: the chain goes with its hops rather than
    // resolving to an empty list a request would fall off the end of.
    if (hops.length > 0) {
      chains[c.id] = hops
    }
  }
  return chains
}
