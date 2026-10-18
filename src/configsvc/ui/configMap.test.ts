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
    'subgraph Models ["Models"]',
    'm0["@/e/m"]',
    'm1["@/gone/z<br/><small>unresolved</small>"]:::bad',
    'c0 --> m0',
    'm0 --> e0',
    'c0 -.-> m1',
    'e0 -- "1 route" --> u0',
    'e1 -- "1 route" --> ambient',
    'class e1 off',
    'style Chains fill:#b48cff26,stroke:#b48cff',
    'style Models fill:#f0b44c26,stroke:#f0b44c',
    'style kind_tts fill:#5b9dff26,stroke:#5b9dff',
    'style egress_none fill:#3fb8af26,stroke:#3fb8af',
  ]) {
    expect(map).toContain(line)
  }
})

test('chains naming the same models in any order share one node per model, unnumbered', () => {
  const doc = parseDoc(
    '[[engine]]\nid = "e"\n[[route]]\nengine = "e"\nmodel = "a"\n[[route]]\nengine = "e"\nmodel = "b"\n[[chain]]\nid = "one"\nhops = ["@/e/a", "@/e/b"]\n[[chain]]\nid = "two"\nhops = ["@/e/b", "@/e/a"]\n',
  )
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  const map = configMermaid(
    doc,
    () => null,
    () => 'openai-http',
  )
  expect(map.match(/\["@\/e\/a"\]/g)).toHaveLength(1)
  expect(map.match(/\["@\/e\/b"\]/g)).toHaveLength(1)
  expect(map.match(/m\d --> e0/g)).toHaveLength(2)
  for (const line of ['c0 --> m0', 'c0 --> m1', 'c1 --> m1', 'c1 --> m0']) {
    expect(map).toContain(line)
  }
  expect(map).not.toMatch(/"\d+\. /)
})
