/** The pending config as a Mermaid flowchart: chains reach engines through their hops, engines reach upstreams through their routes. */
import { type EngineKind, KIND_LABELS } from '../../types.ts'
import { candidates } from './addresses.ts'
import type { Doc, Table } from './model.ts'

type UpstreamOf = (route: Table) => string | null

/** Mermaid takes a quoted label verbatim except for `"`, which needs its entity. */
const label = (text: string) => `"${text.replace(/"/g, '#quot;')}"`

/** No upstream for a route means the engine runs on its own login (an agentic CLI's ambient account). */
const AMBIENT = 'own login'

export function configMermaid(
  doc: Doc,
  upstreamOf: UpstreamOf,
  kindOf: (engine: Table) => EngineKind | undefined,
): string {
  const lines = ['flowchart LR']
  const off: string[] = []
  const engineNode = new Map(doc.engine.map((e, i) => [String(e.id), `e${i}`]))
  const upstreamNode = new Map(doc.upstream.map((u, i) => [String(u.id), `u${i}`]))
  const chainNode = new Map(doc.chain.map((c, i) => [`@/${String(c.id)}`, `c${i}`]))
  const extra: string[] = []

  lines.push('  subgraph Chains')
  doc.chain.forEach((c, i) => {
    lines.push(`    c${i}([${label(`@/${String(c.id)}`)}])`)
    if (c.disable === true) {
      off.push(`c${i}`)
    }
  })
  lines.push('  end', '  subgraph Engines')
  doc.engine.forEach((e, i) => {
    const kind = kindOf(e)
    const sub = kind === undefined ? '' : `<br/><small>${KIND_LABELS[kind]}</small>`
    lines.push(`    e${i}[${label(`${String(e.id)}${sub}`)}]`)
    if (e.disable === true) {
      off.push(`e${i}`)
    }
  })
  lines.push('  end', '  subgraph Upstreams')
  doc.upstream.forEach((u, i) => {
    const egress = typeof u.egress === 'string' ? `<br/><small>egress ${u.egress}</small>` : ''
    lines.push(`    u${i}[(${label(`${String(u.id)}${egress}`)})]`)
    if (u.disable === true) {
      off.push(`u${i}`)
    }
  })
  lines.push('  end')

  doc.chain.forEach((c, i) => {
    const hops = Array.isArray(c.hops)
      ? c.hops.filter((h): h is string => typeof h === 'string')
      : []
    hops.forEach((hop, n) => {
      const via = label(`${n + 1}. ${hop}`)
      const chained = chainNode.get(hop)
      const engines = [...new Set(candidates(doc, hop, upstreamOf).map((r) => String(r.engine)))]
      const targets =
        chained === undefined ? engines.flatMap((e) => engineNode.get(e) ?? []) : [chained]
      if (targets.length === 0) {
        const missing = `x${extra.length}`
        extra.push(`  ${missing}[${label(`${hop}<br/><small>unresolved</small>`)}]:::bad`)
        lines.push(`  c${i} -. ${via} .-> ${missing}`)
      }
      for (const target of targets) {
        lines.push(`  c${i} -- ${via} --> ${target}`)
      }
    })
  })

  let ambient = false
  const pairs = new Map<string, { live: number; total: number }>()
  for (const route of doc.route) {
    const from = engineNode.get(String(route.engine))
    if (from === undefined) {
      continue
    }
    const up = upstreamOf(route)
    const to = (up === null ? undefined : upstreamNode.get(up)) ?? 'ambient'
    ambient ||= to === 'ambient'
    const key = `${from} ${to}`
    const pair = pairs.get(key) ?? { live: 0, total: 0 }
    pair.total += 1
    pair.live += route.disable === true ? 0 : 1
    pairs.set(key, pair)
  }
  for (const [key, { live, total }] of pairs) {
    const [from, to] = key.split(' ')
    const text = label(`${total} route${total === 1 ? '' : 's'}`)
    lines.push(live === 0 ? `  ${from} -. ${text} .-> ${to}` : `  ${from} -- ${text} --> ${to}`)
  }

  if (ambient) {
    extra.push(`  ambient([${label(AMBIENT)}])`)
  }
  lines.push(...extra)
  lines.push('  classDef off stroke-dasharray: 4 3,opacity: 0.5', '  classDef bad stroke: #f0626b')
  if (off.length > 0) {
    lines.push(`  class ${off.join(',')} off`)
  }
  return `${lines.join('\n')}\n`
}
