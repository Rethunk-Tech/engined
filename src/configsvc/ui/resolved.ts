/** What a route resolves to once defaults and precedence are applied: the upstream, capabilities and args the door will use. */
import { AGENT_PREPENDED_ARGV } from '../../agenticArgs.ts'
import { mergeCapabilities, roleCapabilities } from '../../capabilities.ts'
import { CAPABILITY_FIELDS } from '../../configKeys.ts'
import type { ModelCapabilities, Role } from '../../types.ts'
import {
  type Doc,
  defaultUpstream,
  engineTrait,
  isTable,
  routesOf,
  type SpecInfo,
  type Table,
} from './model.ts'

interface ArgRow {
  key: string
  value: unknown
  source: 'spec' | 'engine' | 'route'
  /** A lower layer's value this row replaced. */
  overrides?: unknown
}

export interface Resolved {
  upstream: { value: string | null; note: string; declared: boolean }
  capabilities: ModelCapabilities
  args: ArgRow[]
  /** Flags engined prepends on every launch of this agent; a config cannot change them. */
  floor: string[]
}

const capsOf = (t: Table | undefined): ModelCapabilities => {
  const out: Record<string, unknown> = {}
  for (const key of CAPABILITY_FIELDS) {
    if (t?.[key] !== undefined) {
      out[key] = t[key]
    }
  }
  return out as ModelCapabilities
}

/** Route beats engine, config beats spec, floor beats everything. */
function mergeArgs(spec: Table, engine: Table, route: Table): ArgRow[] {
  const rows = new Map<string, ArgRow>()
  const layers: [ArgRow['source'], unknown][] = [
    ['spec', spec],
    ['engine', engine.args],
    ['route', route.args],
  ]
  for (const [source, args] of layers) {
    if (isTable(args)) {
      for (const [key, value] of Object.entries(args)) {
        rows.set(key, { key, value, source, overrides: rows.get(key)?.value })
      }
    }
  }
  return [...rows.values()]
}

export function resolveRoute(
  doc: Doc,
  route: Table,
  engine: Table,
  spec: SpecInfo | undefined,
): Resolved {
  const declared = typeof route.upstream === 'string'
  const siblings = routesOf(doc, String(engine.id)).map((r) => r.route)
  const fallback = defaultUpstream(engineTrait(engine, spec), siblings)
  const modelRow = doc.model.find((m) => m.id === route.model)
  const agent = spec?.agent === undefined ? undefined : AGENT_PREPENDED_ARGV[spec.agent]
  return {
    upstream: declared
      ? { value: route.upstream as string, note: 'named on the route', declared: true }
      : { ...fallback, declared: false },
    capabilities: mergeCapabilities(
      capsOf(modelRow),
      roleCapabilities(typeof route.role === 'string' ? (route.role as Role) : undefined),
      capsOf(route),
    ),
    args: mergeArgs(spec?.args ?? {}, engine, route),
    floor: (agent ?? []).flat(),
  }
}
