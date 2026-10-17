import { expect, test } from 'bun:test'
import { engineMemory, estimateResidentBytes, memoryVerdict } from './memoryEstimate.ts'

// 32 layers, 32 heads, 8 KV heads, embedding 4096 -> head_dim 128; ctx 1000.
// Elements per K (or V) cache: 32 * 1000 * 8 * 128 = 32_768_000.
const gguf = {
  context_length: 8192,
  block_count: 32,
  head_count: 32,
  head_count_kv: 8,
  embedding_length: 4096,
}
const FILE = { bytes: 1_000_000, gguf }
const ELEMENTS = 32_768_000

test('KV cache follows cache-type-k and cache-type-v separately', () => {
  expect(estimateResidentBytes(FILE, 1000).bytes).toBe(1_000_000 + ELEMENTS * 2 * 2)
  expect(estimateResidentBytes(FILE, 1000, 'q8_0', 'q8_0').bytes).toBe(
    1_000_000 + ELEMENTS * 2 * (34 / 32),
  )
  expect(estimateResidentBytes(FILE, 1000, 'q4_0', 'q4_0').bytes).toBe(
    1_000_000 + ELEMENTS * 2 * (18 / 32),
  )
  expect(estimateResidentBytes(FILE, 1000, 'q8_0', 'f16').bytes).toBe(
    1_000_000 + ELEMENTS * (34 / 32) + ELEMENTS * 2,
  )
})

test('explicit key/value length beats embedding / heads; ctx falls back to the trained window; no shape means file size', () => {
  const wide = {
    bytes: 0,
    gguf: { ...gguf, key_length: 256, value_length: 128, context_length: 1000 },
  }
  expect(estimateResidentBytes(wide, undefined)).toEqual({
    bytes: 32 * 1000 * 8 * (256 * 2 + 128 * 2),
    ctx: 1000,
  })
  expect(estimateResidentBytes({ bytes: 5, gguf: { context_length: 100 } }, 50).bytes).toBe(5)
})

test('engine totals count keep_resident together and on-demand by the largest; verdict compares to the box', () => {
  const m = engineMemory([
    { resident: true, bytes: 10 },
    { resident: true, bytes: 5 },
    { resident: false, bytes: 7 },
    { resident: false, bytes: 3 },
  ])
  expect(m).toEqual({ resident: 15, largestOnDemand: 7 })
  expect(memoryVerdict(22, { total: 20, available: 10 })?.level).toBe('bad')
  expect(memoryVerdict(22, { total: 30, available: 10 })?.level).toBe('note')
  expect(memoryVerdict(22, { total: 30, available: 30 })).toBeUndefined()
})
