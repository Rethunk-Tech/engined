import { expect, test } from 'bun:test'
import { configMermaid } from './configMap.ts'
import { parseDoc, type Table } from './model.ts'

test('the map links chains to engines and engines to upstreams, dashing what is off', () => {
  const doc = parseDoc(
    '[[engine]]\nid = "e"\n[[engine]]\nid = "agent"\ndisable = true\n[[upstream]]\nid = "local"\negress = "none"\n[[route]]\nengine = "e"\nmodel = "m"\n[[route]]\nengine = "agent"\nmodel = "x"\n[[chain]]\nid = "c"\nhops = ["@/e/m", "@/gone/z"]\n',
  )
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  const upstreamOf = (route: Table) => (route.engine === 'e' ? 'local' : null)
  const map = configMermaid(doc, upstreamOf, (e) => (e.id === 'e' ? 'tts' : undefined))
  for (const line of [
    'subgraph kind_tts ["Text to speech"]',
    'e0["e"]',
    'subgraph kind_unknown ["Engines"]',
    'subgraph egress_none ["This box"]',
    'u0[("local")]',
    'subgraph egress_remote ["Internet"]',
    'ambient(["own login"])',
    'c0 -- "1. @/e/m" --> e0',
    'c0 -. "2. @/gone/z" .-> x0',
    'e0 -- "1 route" --> u0',
    'e1 -- "1 route" --> ambient',
    'class e1 off',
  ]) {
    expect(map).toContain(line)
  }
})
