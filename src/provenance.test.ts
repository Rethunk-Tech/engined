import { expect, test } from 'bun:test'
import { type Attempt, type CallRecord, recordCall } from './provenance.ts'
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
