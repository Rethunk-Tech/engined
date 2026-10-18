import { describe, expect, test } from 'bun:test'
import { pickUsage, StreamUsage } from './streamUsage.ts'

describe('pickUsage', () => {
  const full = (over: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    cost_usd?: number
  }) => ({
    prompt_tokens: undefined as number | undefined,
    completion_tokens: undefined as number | undefined,
    total_tokens: undefined as number | undefined,
    cost_usd: undefined as number | undefined,
    ...over,
  })

  test.each([
    [
      'all tokens',
      { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      full({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }),
    ],
    ['cost_usd wins over cost', { cost_usd: 0.1, cost: 9 }, full({ cost_usd: 0.1 })],
    ['OpenRouter cost spelling', { cost: 0.2 }, full({ cost_usd: 0.2 })],
    ['a string token count is not a figure', { prompt_tokens: '12' }, undefined],
    ['NaN is not a figure', { total_tokens: Number.NaN }, undefined],
    ['empty object is not a cost record', {}, undefined],
  ])('%s', (_name, raw, want) => {
    expect(pickUsage(raw)).toEqual(want)
  })
})

describe('StreamUsage', () => {
  const enc = new TextEncoder()

  test('the last usage frame wins, and a token delta is never parsed', () => {
    const u = new StreamUsage()
    u.push(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
    u.push(enc.encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'))
    u.push(
      enc.encode(
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n',
      ),
    )
    expect(u.done()).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      cost_usd: undefined,
    })
  })

  test('a JSON body with no SSE framing still yields its usage', () => {
    const u = new StreamUsage()
    u.push(enc.encode('{"id":"x","usage":{"prompt_tokens":4,"cost":0.05}}'))
    expect(u.done()).toEqual({
      prompt_tokens: 4,
      completion_tokens: undefined,
      total_tokens: undefined,
      cost_usd: 0.05,
    })
  })
})
