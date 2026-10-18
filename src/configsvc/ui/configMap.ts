/** The pending config as a Mermaid flowchart: chains reach engines through the models their hops name, engines reach upstreams through their routes. */
import type { EngineKind } from '../../types.ts'
import { candidates } from './addresses.ts'
import type { Doc, Table } from './model.ts'

type UpstreamOf = (route: Table) => string | null

/** Mermaid takes a quoted label verbatim except for `"`, which needs its entity. */
const label = (text: string) => `"${text.replace(/"/g, '#quot;')}"`

/** No upstream for a route means the engine runs on its own login (an agentic CLI's ambient account). */
const SUBGRAPH_ID_RE = /^ {2}subgraph (\S+)/

const AMBIENT_NODE = `ambient([${label('own login')}])`

/** Engines grouped by kind, so no one column holds every engine. */
const KIND_GROUPS: Record<EngineKind, string> = {
  'openai-http': 'Language models',
  'agentic-cli': 'Agent CLIs',
  tts: 'Text to speech',
  stt: 'Speech to text',
  comfy: 'Image generation',
}

/** Upstreams grouped by how far a call travels; an engine's own login reaches its vendor over the internet. */
const EGRESS_GROUPS = [
  ['none', 'This box'],
  ['lan', 'Local network'],
  ['remote', 'Internet'],
] as const

/** One colour per kind of entry, shared by the chart's groups and the Map's legend. */
export const MAP_COLOURS = {
  chain: '#b48cff',
  model: '#f0b44c',
  engine: '#5b9dff',
  upstream: '#3fb8af',
} as const

/** A group's tint: a translucent fill of its colour, outlined in it. */
const tint = (id: string, colour: string) => `  style ${id} fill:${colour}26,stroke:${colour}`

/** A subgraph of node lines, or nothing when it would be empty. */
const group = (id: string, title: string, nodes: string[]): string[] =>
  nodes.length === 0
    ? []
    : [`  subgraph ${id} [${label(title)}]`, ...nodes.map((n) => `    ${n}`), '  end']

/**
 * One node per model a hop names, shared by every chain that names it: the map shows which
 * chains reach which models, not hop order. A hop naming another chain links the two chains.
 */
function chainEdges(
  doc: Doc,
  upstreamOf: UpstreamOf,
  engineNode: Map<string, string>,
): { edges: string[]; models: string[] } {
  const chainNode = new Map(doc.chain.map((c, i) => [`@/${String(c.id)}`, `c${i}`]))
  const modelNode = new Map<string, { id: string; resolved: boolean }>()
  const models: string[] = []
  const edges = new Set<string>()
  doc.chain.forEach((c, i) => {
    const hops = Array.isArray(c.hops)
      ? c.hops.filter((h): h is string => typeof h === 'string')
      : []
    for (const hop of hops) {
      const chained = chainNode.get(hop)
      if (chained !== undefined) {
        edges.add(`  c${i} --> ${chained}`)
        continue
      }
      let model = modelNode.get(hop)
      if (model === undefined) {
        const engines = new Set(candidates(doc, hop, upstreamOf).map((r) => String(r.engine)))
        const targets = [...engines].flatMap((e) => engineNode.get(e) ?? [])
        model = { id: `m${modelNode.size}`, resolved: targets.length > 0 }
        modelNode.set(hop, model)
        models.push(
          model.resolved
            ? `${model.id}[${label(hop)}]`
            : `${model.id}[${label(`${hop}<br/><small>unresolved</small>`)}]:::bad`,
        )
        for (const target of targets) {
          edges.add(`  ${model.id} --> ${target}`)
        }
      }
      edges.add(model.resolved ? `  c${i} --> ${model.id}` : `  c${i} -.-> ${model.id}`)
    }
  })
  return { edges: [...edges], models }
}

/** One edge per engine and upstream pair, labelled with its route count; dashed when every route on it is disabled. */
function routeEdges(
  doc: Doc,
  upstreamOf: UpstreamOf,
  engineNode: Map<string, string>,
  upstreamNode: Map<string, string>,
): { edges: string[]; ambient: boolean } {
  const pairs = new Map<string, { live: number; total: number }>()
  for (const route of doc.route) {
    const from = engineNode.get(String(route.engine))
    if (from === undefined) {
      continue
    }
    const up = upstreamOf(route)
    const key = `${from} ${(up === null ? undefined : upstreamNode.get(up)) ?? 'ambient'}`
    const pair = pairs.get(key) ?? { live: 0, total: 0 }
    pair.total += 1
    pair.live += route.disable === true ? 0 : 1
    pairs.set(key, pair)
  }
  const edges = [...pairs].map(([key, { live, total }]) => {
    const [from, to] = key.split(' ')
    const text = label(`${total} route${total === 1 ? '' : 's'}`)
    return live === 0 ? `  ${from} -. ${text} .-> ${to}` : `  ${from} -- ${text} --> ${to}`
  })
  return { edges, ambient: [...pairs.keys()].some((key) => key.endsWith(' ambient')) }
}

export function configMermaid(
  doc: Doc,
  upstreamOf: UpstreamOf,
  kindOf: (engine: Table) => EngineKind | undefined,
): string {
  const engineNode = new Map(doc.engine.map((e, i) => [String(e.id), `e${i}`]))
  const upstreamNode = new Map(doc.upstream.map((u, i) => [String(u.id), `u${i}`]))
  const chains = chainEdges(doc, upstreamOf, engineNode)
  const routes = routeEdges(doc, upstreamOf, engineNode, upstreamNode)

  const kinds = doc.engine.map((e) => kindOf(e))
  const engineGroups = [...(Object.keys(KIND_GROUPS) as EngineKind[]), undefined].flatMap((kind) =>
    group(
      `kind_${kind ?? 'unknown'}`,
      kind === undefined ? 'Engines' : KIND_GROUPS[kind],
      doc.engine.flatMap((e, i) => (kinds[i] === kind ? [`e${i}[${label(String(e.id))}]`] : [])),
    ),
  )
  const upstreamGroups = EGRESS_GROUPS.flatMap(([egress, title]) =>
    group(`egress_${egress}`, title, [
      ...doc.upstream.flatMap((u, i) =>
        u.egress === egress ? [`u${i}[(${label(String(u.id))})]`] : [],
      ),
      ...(egress === 'remote' && routes.ambient ? [AMBIENT_NODE] : []),
    ]),
  )
  const ungrouped = doc.upstream.flatMap((u, i) =>
    EGRESS_GROUPS.some(([egress]) => u.egress === egress)
      ? []
      : [`  u${i}[(${label(`${String(u.id)}<br/><small>egress unset</small>`)})]:::bad`],
  )
  const off = [
    ...doc.chain.flatMap((c, i) => (c.disable === true ? [`c${i}`] : [])),
    ...doc.engine.flatMap((e, i) => (e.disable === true ? [`e${i}`] : [])),
    ...doc.upstream.flatMap((u, i) => (u.disable === true ? [`u${i}`] : [])),
  ]
  const lines = [
    'flowchart LR',
    ...group(
      'Chains',
      'Chains',
      doc.chain.map((c, i) => `c${i}([${label(`@/${String(c.id)}`)}])`),
    ),
    ...group('Models', 'Models', chains.models),
    ...engineGroups,
    ...upstreamGroups,
    ...chains.edges,
    ...routes.edges,
    ...ungrouped,
    ...doc.chain.slice(0, 1).map(() => tint('Chains', MAP_COLOURS.chain)),
    ...chains.models.slice(0, 1).map(() => tint('Models', MAP_COLOURS.model)),
    ...engineGroups
      .flatMap((l) => l.match(SUBGRAPH_ID_RE)?.slice(1) ?? [])
      .map((id) => tint(id, MAP_COLOURS.engine)),
    ...upstreamGroups
      .flatMap((l) => l.match(SUBGRAPH_ID_RE)?.slice(1) ?? [])
      .map((id) => tint(id, MAP_COLOURS.upstream)),
    '  classDef off stroke-dasharray: 4 3,opacity: 0.5',
    '  classDef bad stroke: #f0626b',
    ...(off.length === 0 ? [] : [`  class ${off.join(',')} off`]),
  ]
  return `${lines.join('\n')}\n`
}
