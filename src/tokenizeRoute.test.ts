import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { LOCAL_LLAMA_SPEC, llamaExec, READY_200 } from './doorFixtures.ts'
import { errorMessageOf, jsonErrorBody, STATUS_PAYLOAD_TOO_LARGE } from './http.ts'
import { createDoor } from './main.ts'
import {
  BUNX,
  config,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
  writeGgufFixture,
} from './test-support.ts'
import { MAX_TOKENIZE_CONTENT_CHARS } from './tokenizeRoute.ts'

const TEST_ROOT = makeTestRoot('engined-tokenize-route-test-')

/** A local llama route whose `filename` is a synthetic GGUF fixture -- small enough to write inline, real enough for `readGgufMetadata` to run its own parser against. */
function tokenizableDoorConfig() {
  const root = join(TEST_ROOT, `door-${Math.random().toString(36).slice(2)}`)
  const modelsDir = join(root, 'models')
  writeGgufFixture(join(modelsDir, 'tiny.gguf'), {
    'general.architecture': 'qwen3',
    'tokenizer.ggml.model': 'gpt2',
    'tokenizer.ggml.pre': 'qwen2',
    'tokenizer.ggml.tokens': ['a', 'b', 'ab'],
    'tokenizer.ggml.merges': ['a b'],
  })
  writeEngineSpec(root, 'llama', LOCAL_LLAMA_SPEC)
  const cfg = config({
    engines: [engine({ id: 'llama', models_dir: modelsDir })],
    routes: [route({ engine: 'llama', model: 'tiny', filename: 'tiny.gguf', role: 'chat' })],
  })
  return createDoor(cfg, { enginesRoot: root, bunx: BUNX, exec: llamaExec(), probe: READY_200 })
}

describe('POST /engined/v1/tokenize', () => {
  test("counts a route's tokens from its GGUF vocab alone, no engine started", async () => {
    const door = tokenizableDoorConfig()
    const res = await door.fetch(
      new Request('http://engined/engined/v1/tokenize', {
        method: 'POST',
        body: JSON.stringify({ model: '@/llama/tiny', content: 'ab' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tokens: 1 })
  })

  test('an unknown model address is a 400', async () => {
    const door = tokenizableDoorConfig()
    const res = await door.fetch(
      new Request('http://engined/engined/v1/tokenize', {
        method: 'POST',
        body: JSON.stringify({ model: '@/llama/nope', content: 'ab' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  test('content past the character cap is 413', async () => {
    const door = tokenizableDoorConfig()
    const res = await door.fetch(
      new Request('http://engined/engined/v1/tokenize', {
        method: 'POST',
        body: JSON.stringify({
          model: '@/llama/tiny',
          content: ' '.repeat(MAX_TOKENIZE_CONTENT_CHARS + 1),
        }),
      }),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual(jsonErrorBody(STATUS_PAYLOAD_TOO_LARGE, 'content too large'))
  })

  test('a route with no local GGUF to read is a 400 naming that', async () => {
    const root = join(TEST_ROOT, `door-${Math.random().toString(36).slice(2)}`)
    writeEngineSpec(root, 'remote', LOCAL_LLAMA_SPEC)
    const cfg = config({
      engines: [engine({ id: 'remote' })],
      routes: [route({ engine: 'remote', model: 'x', upstream: 'openrouter' })],
    })
    const door = createDoor(cfg, {
      enginesRoot: root,
      bunx: BUNX,
      exec: llamaExec(),
      probe: READY_200,
    })
    const res = await door.fetch(
      new Request('http://engined/engined/v1/tokenize', {
        method: 'POST',
        body: JSON.stringify({ model: '@/remote/x', content: 'hi' }),
      }),
    )
    expect(res.status).toBe(400)
    expect(errorMessageOf(await res.json())).toContain('no local GGUF')
  })
})

describe('GET /openai/v1/models advertises vocab-only tokenize', () => {
  test('a route whose GGUF this door can read cold lists /engined/v1/tokenize in serves', async () => {
    const door = tokenizableDoorConfig()
    const res = await door.fetch(new Request('http://engined/openai/v1/models'))
    const { data } = (await res.json()) as { data: { id: string; serves: string[] }[] }
    const row = data.find((r) => r.id === '@/llama/tiny')
    expect(row?.serves).toContain('/engined/v1/tokenize')
  })
})
