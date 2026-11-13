import { expect, test } from 'bun:test'
import {
  type Attempt,
  type CallRecord,
  CallSummaries,
  flushCallSummaries,
  recordCall,
} from './provenance.ts'
import { collectLines, soleProvenanceRecord } from './test-support.ts'

const DURATION_A_MS = 120
const DURATION_B_MS = 340
const DURATION_C_MS = 15
const ATTEMPT_COUNT = 3

test('recordCall: one call with three attempts emits exactly one line carrying all three failure reasons', () => {
  const { lines, write } = collectLines()
  const record: CallRecord = {
    chain: 'chat',
    requested: '@/chat/default',
    attempts: [
      {
        engine: 'llama-a',
        model: 'chat',
        ok: false,
        failure: 'connection refused',
        duration_ms: DURATION_A_MS,
      },
      {
        engine: 'llama-b',
        model: 'chat',
        ok: false,
        failure: 'timeout',
        duration_ms: DURATION_B_MS,
      },
      { engine: 'llama-c', model: 'chat', ok: true, duration_ms: DURATION_C_MS },
    ],
    engine_used: 'llama-c',
    upstream_used: null,
  }

  recordCall(record, write)

  const parsed = soleProvenanceRecord(lines)
  expect(parsed.attempts).toHaveLength(ATTEMPT_COUNT)
  expect(parsed.attempts[0]?.failure).toBe('connection refused')
  expect(parsed.attempts[1]?.failure).toBe('timeout')
  expect(parsed.attempts[2]?.ok).toBe(true)
})

test('recordCall: model_reported and model_resident survive as distinct fields when they differ', () => {
  const { lines, write } = collectLines()
  const record: CallRecord = {
    chain: null,
    requested: '@/llama/router-section',
    attempts: [
      {
        engine: 'llama-a',
        model: 'router-section',
        ok: true,
        duration_ms: DURATION_A_MS,
        model_reported: 'router-section',
        model_resident: 'qwen3-30b-a3b-q4.gguf',
      },
    ],
    engine_used: 'llama-a',
    upstream_used: null,
  }

  recordCall(record, write)

  const parsed = soleProvenanceRecord(lines)
  expect(parsed.attempts[0]?.model_reported).toBe('router-section')
  expect(parsed.attempts[0]?.model_resident).toBe('qwen3-30b-a3b-q4.gguf')
  expect(parsed.attempts[0]?.model_reported).not.toBe(parsed.attempts[0]?.model_resident)
})

test("recordCall: an agentic attempt's version equals the pin that was launched; a non-agentic attempt carries no version field", () => {
  const { lines, write } = collectLines()
  const record: CallRecord = {
    chain: null,
    requested: 'claude',
    attempts: [
      { engine: 'claude', model: '', ok: true, duration_ms: DURATION_A_MS, version: '1.2.3' },
      { engine: 'llama-a', model: 'chat', ok: true, duration_ms: DURATION_B_MS },
    ],
    engine_used: 'claude',
    upstream_used: null,
  }

  recordCall(record, write)

  const parsed = soleProvenanceRecord(lines)
  expect(parsed.attempts[0]?.version).toBe('1.2.3')
  expect(parsed.attempts.map((a) => Object.hasOwn(a, 'version'))).toEqual([true, false])
})

test('recordCall: each attempt carries its own duration_ms', () => {
  const { lines, write } = collectLines()
  const record: CallRecord = {
    chain: 'chat',
    requested: '@/chat/default',
    attempts: [
      {
        engine: 'llama-a',
        model: 'chat',
        ok: false,
        failure: 'timeout',
        duration_ms: DURATION_A_MS,
      },
      { engine: 'llama-b', model: 'chat', ok: true, duration_ms: DURATION_B_MS },
    ],
    engine_used: 'llama-b',
    upstream_used: null,
  }

  recordCall(record, write)

  const parsed = soleProvenanceRecord(lines)
  expect(parsed.attempts[0]?.duration_ms).toBe(DURATION_A_MS)
  expect(parsed.attempts[1]?.duration_ms).toBe(DURATION_B_MS)
})

test('recordCall: a secret spread onto an attempt is dropped from the emitted line', () => {
  const { lines, write } = collectLines()
  const tainted = {
    engine: 'llama-a',
    model: 'chat',
    ok: false,
    failure: 'unauthorized',
    duration_ms: DURATION_A_MS,
    authorization: 'Bearer sk-live-do-not-log',
    api_key: 'sk-super-secret',
  } as Attempt
  const record: CallRecord = {
    chain: 'chat',
    requested: '@/chat/default',
    attempts: [tainted],
    engine_used: null,
    upstream_used: null,
  }

  recordCall(record, write)

  expect(lines[0]).not.toContain('sk-live-do-not-log')
  expect(lines[0]).not.toContain('sk-super-secret')
  expect(lines[0]).not.toContain('authorization')
  expect(lines[0]).not.toContain('api_key')
})

// serializeAttempt and recordCall each pick named fields off their own
// allowlist, so a field written onto Attempt but not onto CallRecord (or the
// reverse) is silently dropped rather than a type error -- this is the one
// place both are checked emitting the SAME line.
test('recordCall: upstream_used survives serialization on both the attempt and the call record', () => {
  const { lines, write } = collectLines()
  const record: CallRecord = {
    chain: null,
    requested: '@/claude/kimi-k3',
    attempts: [
      {
        engine: 'claude',
        model: 'kimi-k3',
        ok: true,
        duration_ms: DURATION_A_MS,
        upstream_used: 'moonshot',
      },
    ],
    engine_used: 'claude',
    upstream_used: 'moonshot',
  }

  recordCall(record, write)

  const parsed = soleProvenanceRecord(lines)
  expect(parsed.attempts[0]?.upstream_used).toBe('moonshot')
  expect(parsed.upstream_used).toBe('moonshot')
})

const FOLD_MAX_MS = 5_000
const MINUTE_MS = 60_000
const FAST_A_MS = 10
const FAST_B_MS = 20
const FAST_C_MS = 30

function okCall(requested: string, duration_ms: number): CallRecord {
  return {
    chain: null,
    requested,
    attempts: [{ engine: 'llama', model: 'embed', ok: true, duration_ms }],
    engine_used: 'llama',
    upstream_used: 'local',
  }
}

test('recordCall: log=summary folds successful sub-5s calls into one line per route per minute', () => {
  const clock = { now: 0 }
  const summaries = new CallSummaries({ now: () => clock.now })
  const { lines, write } = collectLines()
  recordCall(okCall('@/llama/embed', FAST_A_MS), write, { log: 'summary', summaries })
  recordCall(okCall('@/llama/embed', FAST_C_MS), write, { log: 'summary', summaries })
  recordCall(okCall('@/llama/embed', FAST_B_MS), write, { log: 'summary', summaries })
  expect(lines).toEqual([])
  flushCallSummaries(write, summaries)
  expect(lines).toEqual([
    JSON.stringify({
      route: '@/llama/embed',
      count: 3,
      p50_ms: FAST_B_MS,
      max_ms: FAST_C_MS,
    }),
  ])
})

test('recordCall: log=summary still emits failures and 5s-or-slower successes as full lines', () => {
  const clock = { now: 0 }
  const summaries = new CallSummaries({ now: () => clock.now })
  const { lines, write } = collectLines()
  const failed: CallRecord = {
    chain: null,
    requested: '@/llama/embed',
    attempts: [
      {
        engine: 'llama',
        model: 'embed',
        ok: false,
        failure: 'timeout',
        duration_ms: FAST_A_MS,
      },
    ],
    engine_used: null,
    upstream_used: null,
  }
  recordCall(okCall('@/llama/embed', FAST_A_MS), write, { log: 'summary', summaries })
  recordCall(failed, write, { log: 'summary', summaries })
  recordCall(okCall('@/llama/embed', FOLD_MAX_MS), write, { log: 'summary', summaries })
  expect(lines).toHaveLength(2)
  expect(soleProvenanceRecord([lines[0] ?? '']).attempts[0]?.failure).toBe('timeout')
  expect(soleProvenanceRecord([lines[1] ?? '']).attempts[0]?.duration_ms).toBe(FOLD_MAX_MS)
  flushCallSummaries(write, summaries)
  expect(JSON.parse(lines[2] ?? '')).toEqual({
    route: '@/llama/embed',
    count: 1,
    p50_ms: FAST_A_MS,
    max_ms: FAST_A_MS,
  })
})

test('recordCall: log=summary flushes the previous minute when the injected clock rolls', () => {
  const clock = { now: 0 }
  const summaries = new CallSummaries({ now: () => clock.now })
  const { lines, write } = collectLines()
  recordCall(okCall('@/llama/embed', FAST_A_MS), write, { log: 'summary', summaries })
  clock.now = MINUTE_MS
  recordCall(okCall('@/llama/embed', FAST_C_MS), write, { log: 'summary', summaries })
  expect(lines).toEqual([
    JSON.stringify({
      route: '@/llama/embed',
      count: 1,
      p50_ms: FAST_A_MS,
      max_ms: FAST_A_MS,
    }),
  ])
  flushCallSummaries(write, summaries)
  expect(lines[1]).toBe(
    JSON.stringify({
      route: '@/llama/embed',
      count: 1,
      p50_ms: FAST_C_MS,
      max_ms: FAST_C_MS,
    }),
  )
})
