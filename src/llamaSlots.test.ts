import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { bpeTokenIds } from './bpeTokenize.ts'
import { loadBpeVocab } from './bpeVocab.ts'
import { classifyPrompt } from './llamaSlots.ts'
import { makeTestRoot, writeGgufFixture } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-llama-slots-test-')

describe('classifyPrompt', () => {
  test('a long prompt classifies the same as a full tokenize', async () => {
    const path = join(TEST_ROOT, `tiny-${Math.random().toString(36).slice(2)}.gguf`)
    writeGgufFixture(path, {
      'general.architecture': 'qwen3',
      'tokenizer.ggml.model': 'gpt2',
      'tokenizer.ggml.pre': 'gpt2',
      'tokenizer.ggml.tokens': ['a', 'b'],
      'tokenizer.ggml.merges': [],
    })
    const threshold = 256
    const text = 'a'.repeat(3000)
    const classified = await classifyPrompt(path, text, threshold)
    const ids = bpeTokenIds(await loadBpeVocab(path), text)
    expect(classified.sizeClass).toBe(ids.length >= threshold ? 'long' : 'short')
    expect(classified.fingerprint).toBe(
      createHash('sha256').update(ids.slice(0, 2048).join(',')).digest('hex'),
    )
  })
})
