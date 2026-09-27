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

  test('a token-poor prefix does not tokenize the rest of a long prompt', async () => {
    const path = join(TEST_ROOT, `sparse-${Math.random().toString(36).slice(2)}.gguf`)
    const bTokens = ['b']
    const merges: string[] = []
    let chunk = 'b'
    for (let i = 0; i < 12; i++) {
      merges.push(`${chunk} ${chunk}`)
      chunk += chunk
      bTokens.push(chunk)
    }
    writeGgufFixture(path, {
      'general.architecture': 'qwen3',
      'tokenizer.ggml.model': 'gpt2',
      'tokenizer.ggml.pre': 'gpt2',
      'tokenizer.ggml.tokens': [...bTokens, 'a'],
      'tokenizer.ggml.merges': merges,
    })
    const text = `${'b'.repeat(3000)}${'a'.repeat(5_000_000)}`
    const started = performance.now()
    const classified = await classifyPrompt(path, text, 256)
    expect(performance.now() - started).toBeLessThan(200)
    expect(classified.sizeClass).toBe('long')
    expect(classified.fingerprint).toBeDefined()
  })

  test('a megabyte of spaces classifies in under 500 ms', async () => {
    const path = join(TEST_ROOT, `spaces-${Math.random().toString(36).slice(2)}.gguf`)
    writeGgufFixture(path, {
      'general.architecture': 'qwen3',
      'tokenizer.ggml.model': 'gpt2',
      'tokenizer.ggml.pre': 'gpt2',
      'tokenizer.ggml.tokens': ['a', 'b'],
      'tokenizer.ggml.merges': [],
    })
    const started = performance.now()
    await classifyPrompt(path, ' '.repeat(1024 * 1024), 256)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
