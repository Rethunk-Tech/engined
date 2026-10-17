import { expect, test } from 'bun:test'
import { argIssue, argValueFromText, suggestArgKeys } from './argsRules.ts'
import { removalOps } from './guard.ts'
import {
  defaultUpstream,
  parseDoc,
  parseSpec,
  routeAddress,
  routesOf,
  upstreamChoices,
} from './model.ts'
import { resolveRoute } from './resolved.ts'
import { ctxWarning, keepResidentHolder, routePlan } from './routeRules.ts'
import { comfyChoices, modelSuggestions, trainedContext } from './suggest.ts'

const TEXT = `# keep me
[[engine]]
id = "llama"
models_dir = "/m"
[engine.args]
ctx-size = 8192

[[upstream]]
id = "local"
[[upstream]]
id = "claude-api"
wire = "anthropic"
[[upstream]]
id = "or"

[[route]]
engine = "llama"
model = "a"
role = "chat"
keep_resident = true
[[route]]
engine = "llama"
model = "a"
upstream = "or"
role = "chat"
`

test('routes, addresses and upstream choices follow the parser rules', () => {
  const doc = parseDoc(TEXT)
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  expect(routesOf(doc, 'llama').map((r) => r.index)).toEqual([0, 1])
  // two routes share (llama, a): the address needs its upstream segment
  expect(routeAddress(doc, doc.route[1] ?? {})).toBe('@/llama/or/a')
  expect(upstreamChoices('self', undefined, doc.upstream)).toEqual(
    ['local', 'claude-api'.slice(0, 0) || 'or'].filter(Boolean),
  )
  expect(upstreamChoices('optional', 'claude', doc.upstream)).toEqual(['claude-api'])
  expect(upstreamChoices('optional', 'opencode', doc.upstream)).toEqual(['local', 'or'])
  expect(defaultUpstream('self', []).value).toBe('local')
  expect(defaultUpstream('required', [{ upstream: 'or' }]).value).toBe('or')
  expect(defaultUpstream('required', []).value).toBeNull()
  expect(parseDoc('a = = 1')).toBeUndefined()
  expect(
    parseSpec('kind = "agentic-cli"\nupstream = "optional"\nagent = "claude"\n[[artifact]]\nx=1'),
  ).toEqual({
    kind: 'agentic-cli',
    upstream: 'optional',
    agent: 'claude',
    artifacts: true,
    args: {},
  })
})

test('the field plan hides what the kind, role, locality and wildcard forbid; keep_resident names its holder', () => {
  const doc = parseDoc(TEXT)
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  const [engine] = doc.engine
  const [first, second] = doc.route
  if (engine === undefined || first === undefined || second === undefined) {
    throw new Error('fixture')
  }
  const local = routePlan({ kind: 'openai-http', engine, route: first, upstream: 'local' })
  expect(local.filename.disposition).toBe('required')
  expect(local.vision.disposition).toBe('forbidden')
  expect(local.vision_bridge.disposition).toBe('allowed')
  const proxied = routePlan({ kind: 'openai-http', engine, route: second, upstream: 'or' })
  expect(proxied.filename.disposition).toBe('forbidden')
  const wildcard = routePlan({
    kind: 'openai-http',
    engine,
    route: { engine: 'llama', model: '*' },
    upstream: 'or',
  })
  expect(wildcard.keep_resident.disposition).toBe('forbidden')
  expect(wildcard.args.disposition).toBe('forbidden')
  expect(keepResidentHolder(doc.route, { ...second, upstream: 'local' })).toBe(first)
  expect(ctxWarning(32_768, 8192)).toContain('trained context 8192')
  expect(ctxWarning(4096, 8192)).toBeUndefined()
})

test('args are checked as typed: shape, INI limits and the agentic floor flags', () => {
  const route = { site: 'route', kind: 'openai-http' } as const
  expect(argIssue('ctx-size', 4096, route)).toBeUndefined()
  expect(argIssue('model', 'x', route)).toContain('"model"')
  expect(argIssue('a=b', 1, route)).toContain('INI')
  expect(argIssue('dangerously-skip-permissions', true, route)).toContain('read-only floor')
  expect(argIssue('output-format', 'json', route)).toContain('prepends')
  expect(argIssue('force', true, { site: 'engine', kind: 'openai-http' })).toBeUndefined()
  expect(argIssue('force', true, { site: 'engine', kind: 'agentic-cli' })).toContain('floor')
  expect(argValueFromText('true')).toBe(true)
  expect(argValueFromText('0.5')).toBe(0.5)
  expect(argValueFromText('q8_0')).toBe('q8_0')
  expect(
    suggestArgKeys({ args: { alpha: 1 } }, { route: [{ args: { jinja: true, alpha: 1 } }] }, [
      'jinja',
    ]),
  ).toEqual(['alpha'])
})

test('a resolved route layers capabilities and args, route over engine over spec', () => {
  const doc = parseDoc(
    '[[engine]]\nid = "e"\n[engine.args]\na = 1\nb = 1\n[[model]]\nid = "m"\ncontext_in = 100\ninput = ["text"]\n[[route]]\nengine = "e"\nmodel = "m"\nrole = "vision"\ninput = ["text", "image", "pdf"]\n[route.args]\nb = 2\n',
  )
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  const info = parseSpec('upstream = "self"\n[args]\na = 0\nc = 0\n')
  const done = resolveRoute(doc, doc.route[0] ?? {}, doc.engine[0] ?? {}, info)
  expect(done.upstream).toMatchObject({ value: 'local', declared: false })
  expect(done.capabilities).toEqual({
    input: ['text', 'image', 'pdf'],
    output: ['text'],
    context_in: 100,
  })
  expect(done.args.map((r) => [r.key, r.value, r.source])).toEqual([
    ['a', 1, 'engine'],
    ['c', 0, 'spec'],
    ['b', 2, 'route'],
  ])
  const agent = resolveRoute(
    doc,
    {},
    { id: 'x' },
    parseSpec('agent = "claude"\nupstream = "optional"'),
  )
  expect(agent.floor).toContain('--output-format')
})

test('removal ops clear every reference: routes go, loose fields are unset, chains lose hops', () => {
  const doc = parseDoc(
    '[[engine]]\nid = "e"\ndefault_model = "m"\n[[route]]\nengine = "e"\nmodel = "m"\n[[route]]\nengine = "f"\nmodel = "m"\nvision_bridge = "@/e/m"\n[[route]]\nengine = "e"\nmodel = "n"\n[[chain]]\nid = "c"\nhops = ["@/e/m", "@/f/m"]\n[[chain]]\nid = "d"\nhops = ["@/e/m"]\n',
  )
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  const ops = removalOps(doc, [
    'route[0].engine',
    'route[2].engine',
    'route[1].vision_bridge',
    'chain[0].hops[0]',
    'chain[1].hops[0]',
  ])
  expect(ops).toEqual([
    { op: 'setKey', path: ['route', 1, 'vision_bridge'], value: undefined },
    { op: 'setKey', path: ['chain', 0, 'hops'], value: ['@/f/m'] },
    { op: 'removeEntry', table: 'route', index: 2 },
    { op: 'removeEntry', table: 'route', index: 0 },
    { op: 'removeEntry', table: 'chain', index: 1 },
  ])
})

test('suggestions merge model rows, discovery and inventory; GGUF context and comfy files resolve', () => {
  const doc = parseDoc('[[model]]\nid = "m1"\n')
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  const found = {
    providers: { claude: { models: [{ segment: 'sonnet-5', wire: 'x', capabilities: {} }] } },
    inventories: { or: { ids: ['a/b', 'plain'] } },
  }
  expect(modelSuggestions(doc, 'claude', 'or', found)).toEqual(['m1', 'plain', 'sonnet-5'])
  const files = [
    { path: 'q/x.gguf', bytes: 1, gguf: { context_length: 8192, has_chat_template: true } },
    { path: 'vae/ae.safetensors', bytes: 2 },
    { path: 'unet/u.safetensors', bytes: 3 },
  ]
  expect(trainedContext(files, 'x.gguf')).toBe(8192)
  expect(comfyChoices(files, 'vae')).toEqual(['ae.safetensors'])
  expect(comfyChoices(files, 'unet')).toEqual(['u.safetensors'])
})
