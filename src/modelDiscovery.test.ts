import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ModelDiscovery, parseCursorModels } from './modelDiscovery.ts'
import { config, engine, makeTestRoot, route } from './test-support.ts'

const ROOT = makeTestRoot('engined-discovery-test-')

function modelRow(id: string, line: string, created: string, image = true) {
  return {
    type: 'model',
    id,
    display_name: id,
    line,
    created_at: created,
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      image_input: { supported: image },
      effort: {
        supported: true,
        low: { supported: true },
        high: { supported: true },
        max: { supported: false },
      },
    },
  }
}

const LIST = {
  data: [
    modelRow('claude-sonnet-5-5', 'sonnet', '2026-09-28T00:00:00Z'),
    modelRow('claude-opus-5-5', 'opus', '2026-09-21T00:00:00Z'),
    modelRow('claude-sonnet-5', 'sonnet', '2026-06-29T00:00:00Z'),
    modelRow('claude-haiku-4-5-20251001', 'haiku', '2025-10-15T00:00:00Z'),
  ],
  has_more: false,
}

/** A scratch dir holding a Claude login that has not expired. */
function claudeLogin(): string {
  const dir = mkdtempSync(join(ROOT, 'claude-'))
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3_600_000 } }),
  )
  return dir
}

function discovery(over: { body?: unknown; status?: number; stateRoot?: string; log?: string[] }) {
  const seen: Request[] = []
  const d = new ModelDiscovery({
    stateRoot: over.stateRoot ?? mkdtempSync(join(ROOT, 'state-')),
    claudeDir: claudeLogin(),
    env: {},
    log: (l) => over.log?.push(l),
    fetch: async (input, init) => {
      seen.push(new Request(input, init))
      return Response.json(over.body ?? LIST, { status: over.status ?? 200 })
    },
  })
  return { d, seen }
}

const CLAUDE = config({
  engines: [engine({ id: 'claude' })],
  routes: [
    route({
      engine: 'claude',
      model: 'opus-5-5',
      wire_model: 'claude-opus-5-5',
      upstream: null,
      display_name: 'Pinned Opus',
    }),
  ],
})

test('discovered models are added under declared routes, which win and gain provider capabilities', async () => {
  const log: string[] = []
  const { d, seen } = discovery({ log })
  await d.refresh('claude')
  const view = d.apply(CLAUDE)
  const byModel = new Map(view.routes.map((r) => [r.model, r]))
  expect([...byModel.keys()].sort()).toEqual(['haiku-4-5', 'opus-5-5', 'sonnet-5', 'sonnet-5-5'])
  expect(byModel.get('opus-5-5')?.display_name).toBe('Pinned Opus')
  expect(byModel.get('opus-5-5')?.input).toEqual(['text', 'image'])
  expect(byModel.get('sonnet-5-5')).toMatchObject({
    wire_model: 'claude-sonnet-5-5',
    input: ['text', 'image'],
    context_in: 1_000_000,
    reasoning: ['low', 'high'],
  })
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer tok')
  expect(log).toEqual(['models: claude: found 4, added 4, removed 0'])
})

test('the default is the newest sonnet, and default_model overrides it', async () => {
  const { d } = discovery({})
  await d.refresh('claude')
  expect(d.apply(CLAUDE).default_models).toEqual({ claude: 'sonnet-5-5' })
  const pinned = config({
    ...CLAUDE,
    engines: [engine({ id: 'claude', default_model: 'sonnet-5' })],
  })
  expect(d.apply(pinned).default_models).toEqual({ claude: 'sonnet-5' })
})

test('a declared disabled route hides its model', async () => {
  const { d } = discovery({})
  await d.refresh('claude')
  const hidden = config({
    ...CLAUDE,
    routes: [
      route({
        engine: 'claude',
        model: 'sonnet-5-5',
        wire_model: 'claude-sonnet-5-5',
        upstream: null,
        disabled: true,
      }),
    ],
  })
  const served = d.apply(hidden).routes.filter((r) => !r.disabled && r.model === 'sonnet-5-5')
  expect(served).toEqual([])
})

test('a failed refresh keeps the list, and an offline start reads it from disk', async () => {
  const stateRoot = mkdtempSync(join(ROOT, 'state-'))
  await discovery({ stateRoot }).d.refresh('claude')
  const log: string[] = []
  const failing = discovery({ stateRoot, status: 500, log })
  failing.d.start(CLAUDE)
  await failing.d.refresh('claude')
  failing.d.stop()
  expect(log.at(-1)).toBe(
    'models: claude: refresh failed (GET /v1/models returned HTTP 500); keeping 4 cached',
  )
  expect(failing.d.apply(CLAUDE).routes.some((r) => r.model === 'sonnet-5-5')).toBe(true)
})

test('an unchanged refresh says so', async () => {
  const log: string[] = []
  const { d } = discovery({ log })
  await d.refresh('claude')
  await d.refresh('claude')
  expect(log.at(-1)).toBe('models: claude: found 4, unchanged')
})

test('with nothing discovered, a declared claude route still gets its family image input', () => {
  const { d } = discovery({})
  expect(d.apply(CLAUDE).routes[0]?.input).toEqual(['text', 'image'])
})

test('cursor list output parses to ids and display names, with the provider default marked', () => {
  const models = parseCursorModels(
    'Available models\n\nauto - Auto (default)\nglm-5.2-max - GLM 5.2 Max\n\nTip: use --model <id> to switch.\n',
  )
  expect(models.map((m) => [m.wire, m.display_name, m.provider_default])).toEqual([
    ['auto', 'Auto (default)', true],
    ['glm-5.2-max', 'GLM 5.2 Max', false],
  ])
})
