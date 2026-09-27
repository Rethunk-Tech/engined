import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadBpeVocab, UnsupportedVocabError } from './bpeVocab.ts'
import { makeTestRoot, writeGgufFixture } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-bpe-vocab-test-')

describe('loadBpeVocab', () => {
  test('a second call for an unsupported tokenizer does not re-read the file', async () => {
    const path = join(TEST_ROOT, `llama-${Math.random().toString(36).slice(2)}.gguf`)
    writeGgufFixture(path, { 'tokenizer.ggml.model': 'llama' })
    await expect(loadBpeVocab(path)).rejects.toBeInstanceOf(UnsupportedVocabError)
    await Bun.write(path, 'not a gguf file at all')
    await expect(loadBpeVocab(path)).rejects.toBeInstanceOf(UnsupportedVocabError)
  })
})
