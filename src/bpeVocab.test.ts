import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadBpeVocab, UnsupportedVocabError } from './bpeVocab.ts'
import { makeTestRoot, writeGgufFixture } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-bpe-vocab-test-')

describe('loadBpeVocab', () => {
  test('a second call for the same path and mtime does not re-read the file', async () => {
    const path = join(TEST_ROOT, `llama-${Math.random().toString(36).slice(2)}.gguf`)
    writeGgufFixture(path, { 'tokenizer.ggml.model': 'llama' })
    const statFile = async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: 1 })
    await expect(loadBpeVocab(path, statFile)).rejects.toBeInstanceOf(UnsupportedVocabError)
    await Bun.write(path, 'not a gguf file at all')
    await expect(loadBpeVocab(path, statFile)).rejects.toBeInstanceOf(UnsupportedVocabError)
  })

  test('a newer mtime is a different file', async () => {
    const path = join(TEST_ROOT, `llama-${Math.random().toString(36).slice(2)}.gguf`)
    writeGgufFixture(path, { 'tokenizer.ggml.model': 'llama' })
    let mtimeMs = 1
    const statFile = async (): Promise<{ mtimeMs: number }> => ({ mtimeMs })
    await expect(loadBpeVocab(path, statFile)).rejects.toBeInstanceOf(UnsupportedVocabError)
    await Bun.write(path, 'not a gguf file at all')
    mtimeMs = 2
    await expect(loadBpeVocab(path, statFile)).rejects.not.toBeInstanceOf(UnsupportedVocabError)
  })
})
