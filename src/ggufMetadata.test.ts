import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readGgufMetadata } from './ggufMetadata.ts'
import { makeTestRoot, writeGgufFixture } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-gguf-metadata-test-')

describe('readGgufMetadata', () => {
  test('reads the wanted string and array keys, skipping every other one', async () => {
    const path = join(TEST_ROOT, 'model.gguf')
    writeGgufFixture(path, {
      'general.architecture': 'qwen3',
      'general.name': 'unwanted string, skipped without decoding',
      'tokenizer.ggml.model': 'gpt2',
      'tokenizer.ggml.pre': 'qwen2',
      'tokenizer.ggml.tokens': ['a', 'b', 'ab'],
      'tokenizer.ggml.merges': ['a b'],
      'tokenizer.ggml.token_type': ['1', '1', '1'],
    })
    const meta = await readGgufMetadata(path)
    expect(meta.architecture).toBe('qwen3')
    expect(meta.tokenizerModel).toBe('gpt2')
    expect(meta.tokenizerPre).toBe('qwen2')
    expect(meta.tokens).toEqual(['a', 'b', 'ab'])
    expect(meta.merges).toEqual(['a b'])
  })

  test('reads the window, quantization name, chat-template presence and size, wherever the architecture key sits', async () => {
    const path = join(TEST_ROOT, 'details.gguf')
    writeGgufFixture(path, {
      'llama.context_length': 8192,
      'qwen3.context_length': 40_960,
      'general.file_type': 15,
      'tokenizer.chat_template': '{{ messages }}',
      'general.architecture': 'qwen3',
    })
    const meta = await readGgufMetadata(path)
    expect(meta.contextLength).toBe(40_960)
    expect(meta.fileType).toBe(15)
    expect(meta.quantization).toBe('Q4_K_M')
    expect(meta.hasChatTemplate).toBe(true)
    expect(meta.sizeBytes).toBe(Bun.file(path).size)
    expect(meta.tokens).toBeUndefined()
  })

  test('a file with no tokenizer keys at all reads clean, everything absent', async () => {
    const path = join(TEST_ROOT, 'no-tokenizer.gguf')
    writeGgufFixture(path, { 'general.architecture': 'something' })
    const meta = await readGgufMetadata(path)
    expect(meta.architecture).toBe('something')
    expect(meta.tokenizerModel).toBeUndefined()
    expect(meta.tokens).toBeUndefined()
  })

  test('a non-GGUF file is refused rather than misread', async () => {
    const path = join(TEST_ROOT, 'not-gguf.bin')
    await Bun.write(path, 'not a gguf file at all')
    await expect(readGgufMetadata(path)).rejects.toThrow(/bad magic/)
  })
})
