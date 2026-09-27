/**
 * `src/usage.ts`: per-day, per-route aggregation off a `CallRecord`, atomic
 * persistence, corrupt-file recovery, and the `GET /engined/v1/usage` bounds.
 */
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chatRequest,
  createLlamaDoor,
  LOCAL_LLAMA_SPEC,
  makeLlamaHttpClient,
} from './doorFixtures.ts'
import type { CallRecord } from './provenance.ts'
import {
  collectLines,
  config,
  engine,
  makeTestRoot,
  route,
  upstream,
  writeEngineSpec,
} from './test-support.ts'
import { handleUsage, UsageTracker } from './usage.ts'

const TEST_ROOT = makeTestRoot('engined-usage-test-')

function freshDir(): string {
  return mkdtempSync(join(TEST_ROOT, 'usage-'))
}

const DAY_1 = new Date('2026-01-01T12:00:00Z').getTime()
const DAY_2 = new Date('2026-01-02T09:00:00Z').getTime()

function callRecord(attempts: CallRecord['attempts']): CallRecord {
  return { chain: null, requested: '@/x/y', attempts, engine_used: null, upstream_used: null }
}

test('record aggregates requests, ok/failed, tokens, cost and duration per route', () => {
  const tracker = new UsageTracker({ stateRoot: freshDir(), now: () => DAY_1 })
  tracker.record(
    callRecord([
      {
        engine: 'llama',
        model: 'ornith',
        ok: true,
        duration_ms: 100,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        egress: 'none',
      },
    ]),
  )
  tracker.record(
    callRecord([
      { engine: 'llama', model: 'ornith', ok: false, failure: 'timeout', duration_ms: 50 },
    ]),
  )
  tracker.record(callRecord([{ engine: 'claude', model: '', ok: true, duration_ms: 30 }]))

  const rows = tracker.read(1)
  const ornith = rows.find((r) => r.route === 'llama/ornith')
  const claude = rows.find((r) => r.route === 'claude')

  expect(ornith).toMatchObject({
    requests: 2,
    ok: 1,
    failed: 1,
    prompt_tokens: 10,
    completion_tokens: 5,
    duration_ms: 150,
    egress: 'none',
  })
  expect(ornith?.cost_usd).toBeUndefined()
  expect(claude).toMatchObject({ requests: 1, ok: 1, failed: 0, duration_ms: 30 })
  expect(claude?.prompt_tokens).toBeUndefined()
  tracker.shutdown()
})

test('a vision bridge call counts toward the vision route as well as the chat route', () => {
  const tracker = new UsageTracker({ stateRoot: freshDir(), now: () => DAY_1 })
  tracker.record({
    ...callRecord([
      { engine: 'llama', model: 'ornith', ok: true, duration_ms: 100, egress: 'none' },
    ]),
    vision_bridge: [
      { engine: 'llama', model: 'vision', ok: true, duration_ms: 60, egress: 'none' },
    ],
  })
  const rows = tracker.read(1)
  expect(rows.find((r) => r.route === 'llama/ornith')).toMatchObject({
    requests: 1,
    duration_ms: 100,
  })
  expect(rows.find((r) => r.route === 'llama/vision')).toMatchObject({
    requests: 1,
    duration_ms: 60,
  })
  tracker.shutdown()
})

test('cost_usd sums only across attempts that reported one, never a fabricated zero', () => {
  const tracker = new UsageTracker({ stateRoot: freshDir(), now: () => DAY_1 })
  tracker.record(
    callRecord([
      { engine: 'claude', model: 'sonnet-5', ok: true, duration_ms: 1, usage: { cost_usd: 0.02 } },
    ]),
  )
  tracker.record(
    callRecord([
      { engine: 'claude', model: 'sonnet-5', ok: true, duration_ms: 1, usage: { cost_usd: 0.03 } },
    ]),
  )
  const row = tracker.read(1).find((r) => r.route === 'claude/sonnet-5')
  expect(row?.cost_usd).toBeCloseTo(0.05)
  tracker.shutdown()
})

test('read spans multiple days, most recent first, each keeping its own counters', () => {
  let now = DAY_1
  const tracker = new UsageTracker({ stateRoot: freshDir(), now: () => now })
  tracker.record(callRecord([{ engine: 'llama', model: 'ornith', ok: true, duration_ms: 1 }]))
  now = DAY_2
  tracker.record(callRecord([{ engine: 'llama', model: 'ornith', ok: true, duration_ms: 2 }]))
  now = DAY_2

  const rows = tracker.read(2)
  const dates = rows.map((r) => r.date)
  expect(dates[0]).toBe('2026-01-02')
  expect(rows.find((r) => r.date === '2026-01-01')?.requests).toBe(1)
  expect(rows.find((r) => r.date === '2026-01-02')?.requests).toBe(1)
  tracker.shutdown()
})

test('flush persists atomically and a fresh tracker reads the same counters back', () => {
  const dir = freshDir()
  const first = new UsageTracker({ stateRoot: dir, now: () => DAY_1 })
  first.record(
    callRecord([{ engine: 'llama', model: 'embed', ok: true, duration_ms: 7, egress: 'lan' }]),
  )
  first.flush()
  first.shutdown()

  expect(existsSync(join(dir, '2026-01-01.json.tmp'))).toBe(false)
  expect(existsSync(join(dir, '2026-01-01.json'))).toBe(true)

  const second = new UsageTracker({ stateRoot: dir, now: () => DAY_1 })
  const row = second.read(1).find((r) => r.route === 'llama/embed')
  expect(row).toMatchObject({ requests: 1, ok: 1, duration_ms: 7, egress: 'lan' })
  second.shutdown()
})

test('a corrupt day file is tolerated: that day starts fresh and one line is logged', () => {
  const dir = freshDir()
  writeFileSync(join(dir, '2026-01-01.json'), '{not json')
  const { lines: logged, write } = collectLines()
  const tracker = new UsageTracker({ stateRoot: dir, now: () => DAY_1, log: write })
  const rows = tracker.read(1)
  expect(rows).toEqual([])
  expect(logged).toHaveLength(1)
  expect(logged[0]).toContain('corrupt')
  tracker.shutdown()
})

test('a day file that is valid JSON but the wrong shape is tolerated the same way', () => {
  const dir = freshDir()
  writeFileSync(
    join(dir, '2026-01-01.json'),
    JSON.stringify({ routes: { x: { requests: 'nope' } } }),
  )
  const { lines: logged, write } = collectLines()
  const tracker = new UsageTracker({ stateRoot: dir, now: () => DAY_1, log: write })
  expect(tracker.read(1)).toEqual([])
  expect(logged).toHaveLength(1)
  tracker.shutdown()
})

test('handleUsage: default days is 7', () => {
  const tracker = new UsageTracker({ stateRoot: freshDir(), now: () => DAY_1 })
  const ctx = { usage: tracker } as unknown as Parameters<typeof handleUsage>[0]
  const res = handleUsage(ctx, new URL('http://x/engined/v1/usage'))
  expect(res.status).toBe(200)
  tracker.shutdown()
})

test('handleUsage: "days" beyond the max is silently clamped to 90', () => {
  const readSpy: number[] = []
  const tracker = {
    read: (days: number) => {
      readSpy.push(days)
      return []
    },
  } as unknown as UsageTracker
  const ctx = { usage: tracker } as unknown as Parameters<typeof handleUsage>[0]
  handleUsage(ctx, new URL('http://x/engined/v1/usage?days=500'))
  expect(readSpy).toEqual([90])
})

test('handleUsage: "days" that is not a positive integer is a 400', () => {
  const tracker = new UsageTracker({ stateRoot: freshDir(), now: () => DAY_1 })
  const ctx = { usage: tracker } as unknown as Parameters<typeof handleUsage>[0]
  for (const bad of ['0', '-3', 'abc', '3.5']) {
    const res = handleUsage(ctx, new URL(`http://x/engined/v1/usage?days=${bad}`))
    expect(res.status).toBe(400)
  }
  tracker.shutdown()
})

test('a real chat call through the door shows up on GET /engined/v1/usage the same day', async () => {
  const root = mkdtempSync(join(TEST_ROOT, 'usage-door-'))
  writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
  const cfg = config({
    engines: [engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 })],
    upstreams: [upstream()],
    routes: [route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat' })],
  })
  const door = createLlamaDoor(cfg, root, {
    llamaHttpClient: makeLlamaHttpClient([]),
    write: () => undefined,
    usageStateRoot: freshDir(),
  })
  const chatRes = await door.fetch(
    chatRequest({ model: '@/local-llama/ornith', messages: [{ role: 'user', content: 'hi' }] }),
  )
  await chatRes.json()

  const res = await door.fetch(new Request('http://engined/engined/v1/usage'))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { route: string; requests: number }[] }
  const row = body.data.find((r) => r.route === 'local-llama/ornith')
  expect(row?.requests).toBe(1)
  door.ctx.usage.shutdown()
})
