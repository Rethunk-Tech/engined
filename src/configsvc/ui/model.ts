/** The pending config text as tables, and what each engine is: the view-model every form reads. */
import { parse } from '@decimalturn/toml-patch'
import { AGENT_WIRES } from '../../agentWires.ts'
import { addressForRoute, LOCAL_UPSTREAM, siblingRouteCount } from '../../routeAddress.ts'
import type { EngineKind, UpstreamTrait, Wire } from '../../types.ts'
import { KIND_TRAITS } from '../../types.ts'

export type Table = Record<string, unknown>

export interface Doc {
  top: Table
  engine: Table[]
  upstream: Table[]
  model: Table[]
  route: Table[]
  chain: Table[]
}

export interface SpecInfo {
  kind?: EngineKind
  upstream?: UpstreamTrait
  agent?: string
  artifacts: boolean
  /** The spec's own `[args]` defaults, which config args override. */
  args: Table
}

export const isTable = (v: unknown): v is Table =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const tables = (v: unknown): Table[] => (Array.isArray(v) ? v.filter(isTable) : [])

/** `undefined` while the text does not parse as TOML at all. */
export function parseDoc(text: string): Doc | undefined {
  try {
    const top = parse(text) as Table
    return {
      top,
      engine: tables(top.engine),
      upstream: tables(top.upstream),
      model: tables(top.model),
      route: tables(top.route),
      chain: tables(top.chain),
    }
  } catch {
    return undefined
  }
}

export function parseSpec(text: string): SpecInfo {
  try {
    const raw = parse(text) as Table
    const kind = raw.kind
    const trait = raw.upstream
    return {
      kind: typeof kind === 'string' && kind in KIND_TRAITS ? (kind as EngineKind) : undefined,
      upstream:
        trait === 'self' || trait === 'optional' || trait === 'required' ? trait : undefined,
      agent: typeof raw.agent === 'string' ? raw.agent : undefined,
      artifacts: Array.isArray(raw.artifact) && raw.artifact.length > 0,
      args: isTable(raw.args) ? raw.args : {},
    }
  } catch {
    return { artifacts: false, args: {} }
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function engineKind(engine: Table, spec: SpecInfo | undefined): EngineKind | undefined {
  const own = str(engine.kind)
  return own !== undefined && own in KIND_TRAITS ? (own as EngineKind) : spec?.kind
}

export function engineTrait(engine: Table, spec: SpecInfo | undefined): UpstreamTrait | undefined {
  const kind = engineKind(engine, spec)
  return spec?.upstream ?? (kind === undefined ? undefined : KIND_TRAITS[kind].upstream)
}

export interface IndexedRoute {
  index: number
  route: Table
}

export function routesOf(doc: Doc, engineId: string): IndexedRoute[] {
  return doc.route.flatMap((route, index) => (route.engine === engineId ? [{ index, route }] : []))
}

/** The address a route answers to, from the same function the door builds it with. */
export function routeAddress(doc: Doc, route: Table): string | undefined {
  const engine = str(route.engine)
  if (engine === undefined) {
    return undefined
  }
  const asRoute = (r: Table) => ({
    engine: String(r.engine),
    model: str(r.model),
    upstream: str(r.upstream) ?? null,
    disabled: r.disable === true,
  })
  const own = asRoute(route)
  return addressForRoute(
    own,
    siblingRouteCount(
      own,
      doc.route.map((r) => asRoute(r)),
    ),
  )
}

/** The upstream a blank `upstream` falls back to, by the engine's trait (configRoutes.ts `defaultUpstreamFor`). */
export function defaultUpstream(
  trait: UpstreamTrait | undefined,
  sibling: readonly Table[],
): { value: string | null; note: string } {
  if (trait === 'self') {
    return { value: LOCAL_UPSTREAM, note: 'this box (local)' }
  }
  if (trait === 'optional') {
    return { value: null, note: "ambient: the CLI's own login" }
  }
  const declared = new Set(
    sibling.flatMap((r) => (str(r.upstream) === undefined ? [] : [r.upstream as string])),
  )
  return declared.size === 1
    ? { value: [...declared][0] as string, note: 'the one upstream the other routes name' }
    : { value: null, note: 'required: name an upstream (none or several are declared elsewhere)' }
}

/** Upstreams a route on this engine may name; advisory, the server's validate is the authority. */
export function upstreamChoices(
  trait: UpstreamTrait | undefined,
  agent: string | undefined,
  upstreams: readonly Table[],
): string[] {
  const wireOf = (u: Table): Wire | undefined =>
    u.wire === 'anthropic' || u.wire === 'openai' ? u.wire : undefined
  const ids = (keep: (u: Table) => boolean) =>
    upstreams.filter(keep).flatMap((u) => (str(u.id) === undefined ? [] : [u.id as string]))
  if (trait === 'self') {
    return ids((u) => u.id === LOCAL_UPSTREAM || wireOf(u) === undefined)
  }
  const agentWire = agent === undefined ? undefined : (AGENT_WIRES as Record<string, Wire>)[agent]
  if (trait === 'optional' || agentWire !== undefined) {
    return ids((u) => (wireOf(u) ?? 'openai') === (agentWire ?? 'openai'))
  }
  return ids(() => true)
}
