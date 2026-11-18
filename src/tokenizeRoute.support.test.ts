import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { DoorContext } from './doorContext.ts'
import { errorMessageOf } from './http.ts'
import { LOCAL_UPSTREAM } from './routeAddress.ts'
import { config, engine, makeTestRoot, route, writeGgufFixture } from './test-support.ts'
import {
  DETOKENIZE_PATH,
  ggufPath,
  handleDetokenizeRoute,
  handleTokenizeRoute,
  supportsVocabTokenize,
  TOKENIZE_PATH,
} from './tokenizeRoute.ts'
import type { Config } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-tokenize-support-')

function ctxFor(cfg: Config): DoorContext {
  return {
    getConfig: () => cfg,
    registry: { entry: () => undefined },
  } as unknown as DoorContext
}

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://engined${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('ggufPath', () => {
  const local = route({
    engine: 'llama',
    model: 'tiny',
    filename: 'tiny.gguf',
    role: 'chat',
    upstream: LOCAL_UPSTREAM,
  })

  test('only a local route with a filename and models_dir names a file to read', () => {
    expect(ggufPath(local, '/models')).toBe(join('/models', 'tiny.gguf'))
    expect(ggufPath(local, undefined)).toBeUndefined()
    expect(ggufPath({ ...local, filename: undefined }, '/models')).toBeUndefined()
    expect(ggufPath({ ...local, upstream: 'openrouter' }, '/models')).toBeUndefined()
  })
})

describe('supportsVocabTokenize', () => {
  const cfg = config({ engines: [engine({ id: 'llama', models_dir: '/models' })] })
  const r = route({ engine: 'llama', model: 'tiny', filename: 'tiny.gguf', role: 'chat' })

  test('a route with no local GGUF, a missing file, or gpt2 without pre is not advertised', async () => {
    expect(
      await supportsVocabTokenize(route({ engine: 'llama', model: 'tiny', role: 'chat' }), cfg),
    ).toBe(false)
    expect(
      await supportsVocabTokenize(r, cfg, {
        statFile: async () => {
          throw new Error('gone')
        },
      }),
    ).toBe(false)
    expect(
      await supportsVocabTokenize(r, cfg, {
        statFile: async () => ({ mtimeMs: 21 }),
        readMeta: async () => ({ tokenizerModel: 'gpt2' }),
      }),
    ).toBe(false)
  })

  test('a failed metadata read is not cached as a lasting no', async () => {
    let reads = 0
    const deps = {
      statFile: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: 22 }),
      readMeta: async (): Promise<{ tokenizerModel?: string; tokenizerPre?: string }> => {
        reads += 1
        if (reads === 1) {
          throw new Error('unreadable')
        }
        return { tokenizerModel: 'gpt2', tokenizerPre: 'qwen2' }
      },
    }
    expect(await supportsVocabTokenize(r, cfg, deps)).toBe(false)
    expect(await supportsVocabTokenize(r, cfg, deps)).toBe(true)
    expect(reads).toBe(2)
  })
})

describe('tokenize and detokenize refuse shapes they cannot count', () => {
  test('missing content, a non-id list, an unqualified model, an unreadable vocab, and an unknown id are 400 or 502', async () => {
    const modelsDir = join(TEST_ROOT, 'models')
    writeGgufFixture(join(modelsDir, 'tiny.gguf'), {
      'general.architecture': 'qwen3',
      'tokenizer.ggml.model': 'gpt2',
      'tokenizer.ggml.pre': 'qwen2',
      'tokenizer.ggml.tokens': ['a', 'b', 'ab'],
      'tokenizer.ggml.merges': ['a b'],
    })
    writeGgufFixture(join(modelsDir, 'sp.gguf'), {
      'general.architecture': 'llama',
      'tokenizer.ggml.model': 'llama',
      'tokenizer.ggml.pre': 'default',
    })
    const cfg = config({
      engines: [engine({ id: 'llama', models_dir: modelsDir })],
      routes: [
        route({ engine: 'llama', model: 'tiny', filename: 'tiny.gguf', role: 'chat' }),
        route({ engine: 'llama', model: 'sp', filename: 'sp.gguf', role: 'chat' }),
        route({ engine: 'llama', model: 'gone', filename: 'gone.gguf', role: 'chat' }),
      ],
    })
    const ctx = ctxFor(cfg)

    const missingContent = await handleTokenizeRoute(
      ctx,
      post(TOKENIZE_PATH, { model: '@/llama/tiny' }),
    )
    expect(missingContent.status).toBe(400)
    expect(errorMessageOf(await missingContent.json())).toContain('content is required')

    const bareModel = await handleTokenizeRoute(
      ctx,
      post(TOKENIZE_PATH, { model: 'tiny', content: 'ab' }),
    )
    expect(bareModel.status).toBe(400)
    expect(errorMessageOf(await bareModel.json())).toContain('unknown model')

    const noTokens = await handleDetokenizeRoute(
      ctx,
      post(DETOKENIZE_PATH, { model: '@/llama/tiny' }),
    )
    expect(noTokens.status).toBe(400)
    expect(errorMessageOf(await noTokens.json())).toContain('tokens is required')

    const fractional = await handleDetokenizeRoute(
      ctx,
      post(DETOKENIZE_PATH, { model: '@/llama/tiny', tokens: [1.5] }),
    )
    expect(fractional.status).toBe(400)
    expect(errorMessageOf(await fractional.json())).toContain('tokens is required')

    const unknownId = await handleDetokenizeRoute(
      ctx,
      post(DETOKENIZE_PATH, { model: '@/llama/tiny', tokens: [99] }),
    )
    expect(unknownId.status).toBe(400)
    expect(errorMessageOf(await unknownId.json())).toContain('token id 99')

    const unsupported = await handleTokenizeRoute(
      ctx,
      post(TOKENIZE_PATH, { model: '@/llama/sp', content: 'ab' }),
    )
    expect(unsupported.status).toBe(400)
    expect(errorMessageOf(await unsupported.json())).toContain('not "gpt2"')

    const missingFile = await handleTokenizeRoute(
      ctx,
      post(TOKENIZE_PATH, { model: '@/llama/gone', content: 'ab' }),
    )
    expect(missingFile.status).toBe(502)
  })
})
