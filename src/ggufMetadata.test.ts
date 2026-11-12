import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
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

  test('reads the layer and head counts, scoped to the file architecture', async () => {
    const path = join(TEST_ROOT, 'shape.gguf')
    writeGgufFixture(path, {
      'llama.block_count': 99,
      'qwen3.block_count': 36,
      'qwen3.attention.head_count': 32,
      'qwen3.attention.head_count_kv': 8,
      'qwen3.embedding_length': 4096,
      'qwen3.attention.key_length': 128,
      'general.architecture': 'qwen3',
    })
    const meta = await readGgufMetadata(path)
    expect([meta.blockCount, meta.headCount, meta.headCountKv, meta.embeddingLength]).toEqual([
      36, 32, 8, 4096,
    ])
    expect(meta.keyLength).toBe(128)
    expect(meta.valueLength).toBeUndefined()
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

describe('readGgufMetadata on a crafted header', () => {
  /** One key "x" holding an array of `elemType` with `count` claimed elements, then `tail` bytes. */
  function craft(name: string, elemType: number, count: bigint, tail: Buffer): string {
    const path = join(TEST_ROOT, name)
    const h = Buffer.alloc(8 + 8 + 8 + 8 + 1 + 4 + 4 + 8)
    let o = h.writeUInt32LE(0x46_55_47_47, 0)
    o = h.writeUInt32LE(3, o)
    o = h.writeBigUInt64LE(0n, o)
    o = h.writeBigUInt64LE(1n, o)
    o = h.writeBigUInt64LE(1n, o)
    o += h.write('x', o)
    o = h.writeUInt32LE(9, o)
    o = h.writeUInt32LE(elemType, o)
    h.writeBigUInt64LE(count, o)
    writeFileSync(path, Buffer.concat([h, tail]))
    return path
  }

  test('an array claiming more elements than the file holds is refused without scanning them', async () => {
    const path = craft('huge.gguf', 7, 1n << 40n, Buffer.alloc(20 * 1024 * 1024))
    const t = performance.now()
    await expect(readGgufMetadata(path)).rejects.toBeDefined()
    expect(performance.now() - t).toBeLessThan(300)
  })

  test('arrays nested past the depth cap are refused', async () => {
    const nested = Buffer.alloc(12)
    nested.writeUInt32LE(9, 0)
    nested.writeBigUInt64LE(1n, 4)
    const path = craft('deep.gguf', 9, 1n, Buffer.concat(Array.from({ length: 10 }, () => nested)))
    await expect(readGgufMetadata(path)).rejects.toThrow('nest too deeply')
  })
})
