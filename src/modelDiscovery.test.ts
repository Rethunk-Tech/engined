import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDoor } from './main.ts'
import { type DiscoveryStatus, ModelDiscovery } from './modelDiscovery.ts'
import { parseCursorModels } from './modelSources.ts'
import { runProbes } from './probe.ts'
import { BUNX, config, engine, makeTestRoot, route } from './test-support.ts'

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
  await Bun.sleep(30)
  failing.d.stop()
  expect(log.at(-1)).toBe(
    'models: claude: refresh failed (GET /v1/models returned HTTP 500); keeping 4 cached, fetched 0 min ago',
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

const CURSOR_LIST = [
  'Available models',
  '',
  'auto - Auto (default)',
  'gpt-5.3-codex-low - Codex 5.3 Low',
  'gpt-5.3-codex-high - Codex 5.3 High',
  'gpt-5.3-codex-high-fast - Codex 5.3 High Fast',
  '',
].join('\n')

async function menuFor(cursorList: string) {
  const d = new ModelDiscovery({
    stateRoot: mkdtempSync(join(ROOT, 'state-')),
    claudeDir: claudeLogin(),
    env: {},
    log: () => undefined,
    fetch: async () => Response.json(LIST),
    cursorExec: async () => ({ stdout: cursorList, stderr: '', exitCode: 0 }),
  })
  const door = createDoor(
    config({
      engines: [
        engine({ id: 'claude', agent_version: '1' }),
        engine({ id: 'cursor', agent_version: '1' }),
      ],
      routes: [],
    }),
    {
      enginesRoot: join(import.meta.dir, '..', 'engines'),
      bunx: BUNX,
      // Engine status asks the installed agent binary for its version; a test must not spawn it.
      observeAgentVersion: () => Promise.resolve({ ok: true, version: '1' }),
    },
    { discovery: d },
  )
  await d.refresh('claude')
  await d.refresh('cursor')
  const res = await door.fetch(new Request('http://engined/openai/v1/models'))
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    data: { engine: string; model: string; default?: boolean }[]
  }
  return body.data
}

test('engines with no declared routes are served from discovery, one default each', async () => {
  const rows = await menuFor(CURSOR_LIST)
  const defaults = rows.filter((r) => r.default).map((r) => `${r.engine}/${r.model}`)
  expect(defaults.sort((a, b) => a.localeCompare(b))).toEqual(['claude/sonnet-5-5', 'cursor/auto'])
  expect(rows.filter((r) => r.engine === 'claude')).toHaveLength(4)
})

test('a default that is a cursor variant marks its collapsed base row', async () => {
  const rows = await menuFor(
    CURSOR_LIST.replace('auto - Auto (default)', 'auto - Auto').replace(
      'gpt-5.3-codex-high - Codex 5.3 High',
      'gpt-5.3-codex-high - Codex 5.3 High (default)',
    ),
  )
  const defaults = rows.filter((r) => r.default && r.engine === 'cursor')
  expect(defaults.map((r) => r.model)).toEqual(['gpt-5.3-codex'])
})

test('a rejected login (401) keeps the cached list and the line gives its age', async () => {
  const stateRoot = mkdtempSync(join(ROOT, 'state-'))
  const log: string[] = []
  let now = 1_000_000
  const opts = {
    stateRoot,
    claudeDir: claudeLogin(),
    env: {},
    now: () => now,
    log: (l: string) => log.push(l),
  }
  await new ModelDiscovery({ ...opts, fetch: async () => Response.json(LIST) }).refresh('claude')
  now += 3 * 60 * 60_000
  const d = new ModelDiscovery({ ...opts, fetch: async () => new Response('no', { status: 401 }) })
  d.start(CLAUDE)
  d.stop()
  await Bun.sleep(30)
  expect(log.at(-1)).toBe(
    'models: claude: refresh failed (GET /v1/models returned HTTP 401); keeping 4 cached, fetched 180 min ago',
  )
  expect(d.apply(CLAUDE).routes.some((r) => r.model === 'sonnet-5-5')).toBe(true)
})

const DECLARED = config({
  engines: [engine({ id: 'claude', agent_version: '1' })],
  routes: [
    // Says nothing discovery does not.
    route({
      engine: 'claude',
      model: 'opus-5-5',
      wire_model: 'claude-opus-5-5',
      upstream: null,
      display_name: 'claude-opus-5-5',
    }),
    route({ engine: 'claude', model: 'sonnet-5', wire_model: 'claude-sonnet-5', upstream: null }),
    // Overrides the label, so it earns its place.
    route({
      engine: 'claude',
      model: 'sonnet-5-5',
      wire_model: 'claude-sonnet-5-5',
      upstream: null,
      display_name: 'Mine',
    }),
    // The provider no longer lists it.
    route({ engine: 'claude', model: 'opus-4-1', wire_model: 'claude-opus-4-1', upstream: null }),
  ],
})

async function engines(door: ReturnType<typeof createDoor>) {
  const res = await door.fetch(new Request('http://engined/engined/v1/engines'))
  return (await res.json()) as { discovery?: Record<string, DiscoveryStatus> }
}

test('declared routes discovery makes redundant or stale become findings with the fix, and the probe prints them', async () => {
  const { d } = discovery({})
  const door = createDoor(
    DECLARED,
    {
      enginesRoot: join(import.meta.dir, '..', 'engines'),
      bunx: BUNX,
      // Engine status asks the installed agent binary for its version; a test must not spawn it.
      observeAgentVersion: () => Promise.resolve({ ok: true, version: '1' }),
    },
    { discovery: d },
  )
  await d.refresh('claude')
  const status = (await engines(door)).discovery?.claude
  expect(status?.findings.map((f) => `${f.kind}:${f.route}`).sort()).toEqual([
    'duplicate:opus-5-5',
    'duplicate:sonnet-5',
    'retired:opus-4-1',
  ])
  expect(status?.findings[0]?.fix).toContain('delete the [[route]] block with engine = "claude"')
  const client = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(door.fetch(new Request(String(input), init)))) as typeof fetch
  const report = await runProbes('http://engined', client)
  expect(report.ok).toBe(true)
  expect(report.lines.map((l) => l.address)).toContain('@/claude/opus-4-1')
})

test('the engines list says when the list was fetched and why the last refresh failed', async () => {
  const stateRoot = mkdtempSync(join(ROOT, 'state-'))
  await discovery({ stateRoot }).d.refresh('claude')
  const failing = discovery({ stateRoot, status: 401 })
  const door = createDoor(
    CLAUDE,
    {
      enginesRoot: join(import.meta.dir, '..', 'engines'),
      bunx: BUNX,
      // Engine status asks the installed agent binary for its version; a test must not spawn it.
      observeAgentVersion: () => Promise.resolve({ ok: true, version: '1' }),
    },
    { discovery: failing.d },
  )
  failing.d.start(CLAUDE)
  failing.d.stop()
  await Bun.sleep(30)
  const status = (await engines(door)).discovery?.claude
  expect(status?.models).toBe(4)
  expect(status?.last_error).toBe('GET /v1/models returned HTTP 401')
  expect(Number.isNaN(Date.parse(status?.fetched_at ?? ''))).toBe(false)
})

test('a provider that never answers delays neither start nor another engine, and times out', async () => {
  const log: string[] = []
  const d = new ModelDiscovery({
    stateRoot: mkdtempSync(join(ROOT, 'state-')),
    env: {},
    log: (l) => log.push(l),
    fetchTimeoutMs: 50,
    claudeDir: claudeLogin(),
    fetch: () => new Promise<Response>(() => undefined),
    cursorExec: async () => ({ stdout: CURSOR_LIST, stderr: '', exitCode: 0 }),
  })
  const both = config({
    engines: [
      engine({ id: 'claude', agent_version: '1' }),
      engine({ id: 'cursor', agent_version: '1' }),
    ],
    routes: [],
  })
  const started = performance.now()
  d.start(both)
  expect(performance.now() - started).toBeLessThan(40)
  await Bun.sleep(150)
  d.stop()
  expect(log).toContain(
    'models: claude: refresh failed (no answer within 50 ms); keeping 0 cached, none fetched yet',
  )
  expect(d.apply(both).routes.some((r) => r.engine === 'cursor')).toBe(true)
})
