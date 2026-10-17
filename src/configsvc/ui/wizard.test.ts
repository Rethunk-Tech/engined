import { expect, test } from 'bun:test'
import { hopChoices } from './addresses.ts'
import { parseDoc } from './model.ts'
import { freeId, PRESETS, providerOps } from './wizard.ts'

test('a provider becomes an upstream, its engine and its routes; the anthropic wire runs on the claude CLI', () => {
  const doc = parseDoc('[[engine]]\nid = "claude"\n[[upstream]]\nid = "openai"\n')
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  const google = PRESETS.find((p) => p.id === 'googleai')
  if (google === undefined) {
    throw new Error('googleai preset must exist')
  }
  const plan = { ...google, service: 'googleai-api', username: 'default' }
  expect(providerOps(doc, { ...plan, models: '*' })).toEqual([
    {
      op: 'addEntry',
      table: 'upstream',
      entry: {
        id: 'googleai',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
        secret: {
          service: 'googleai-api',
          username: 'default',
          header: 'authorization',
          scheme: 'Bearer',
        },
        egress: 'remote',
        wire: 'openai',
        inventory_max_age_seconds: 86_400,
        inventory_refresh_seconds: 3600,
      },
    },
    { op: 'addEntry', table: 'engine', entry: { id: 'googleai', kind: 'openai-http' } },
    {
      op: 'addEntry',
      table: 'route',
      entry: { engine: 'googleai', upstream: 'googleai', model: '*' },
    },
  ])
  const anthropic = providerOps(doc, {
    id: 'anthropic',
    base_url: 'https://api.anthropic.com',
    wire: 'anthropic',
    header: 'x-api-key',
    service: 'anthropic-api',
    username: 'default',
    models: ['m1', 'm2'],
  })
  // claude is already configured, so only the upstream and the two routes are added.
  expect(anthropic.map((op) => (op.op === 'addEntry' ? op.table : op.op))).toEqual([
    'upstream',
    'route',
    'route',
  ])
  expect(
    freeId(
      doc.upstream.map((u) => u.id),
      'openai',
    ),
  ).toBe('openai-2')
})

test('a wildcard route is not offered as a chain hop', () => {
  const doc = parseDoc(
    '[[engine]]\nid = "e"\n[[upstream]]\nid = "up"\n[[route]]\nengine = "e"\nupstream = "up"\nmodel = "m"\n[[route]]\nengine = "e"\nupstream = "up"\nmodel = "*"\n',
  )
  if (doc === undefined) {
    throw new Error('fixture must parse')
  }
  expect(hopChoices(doc, () => 'up', {})).toEqual(['@/e/m'])
})
