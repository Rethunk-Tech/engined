import { describe, expect, test } from 'bun:test'
import { isEngineVerbPath } from './engineVerbs.ts'

describe('isEngineVerbPath', () => {
  test.each([
    ['/engined/v1/engines/llama/stop', true],
    ['/engined/v1/engines/llama/release', true],
    ['/engined/v1/engines/llama/hold', true],
    ['/engined/v1/engines/llama/unhold', true],
    ['/engined/v1/engines/llama/obtain', true],
    ['/engined/v1/upstreams/openrouter/refresh', true],
    ['/engined/v1/engines/llama/logs', false],
    ['/engined/v1/engines', false],
    ['/engined/v1/engines/llama/stop/extra', false],
    ['/openai/v1/chat/completions', false],
  ] as const)('%s', (path, want) => {
    expect(isEngineVerbPath(path)).toBe(want)
  })
})
