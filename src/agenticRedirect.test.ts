import { describe, expect, test } from 'bun:test'
import { claudeModelEnv, resolveUpstreamModelId } from './agenticRedirect.ts'
import { config, route } from './test-support.ts'

describe('resolveUpstreamModelId', () => {
  const wired = route({
    engine: 'or',
    model: 'org%2Fmodel',
    wire_model: 'org/model',
    upstream: 'openrouter',
  })
  const plain = route({ engine: 'or', model: 'haiku', upstream: 'openrouter' })
  const disabled = { ...wired, disabled: true }
  const cfg = config({ routes: [wired, plain] })

  test.each([
    ['empty segment', cfg, 'or', '', undefined, undefined],
    ['wildcard sentinel', cfg, 'or', '*', undefined, undefined],
    [
      'a route with wire_model yields the wire id',
      cfg,
      'or',
      'org%2Fmodel',
      'openrouter',
      'org/model',
    ],
    ['a route without wire_model yields the model', cfg, 'or', 'haiku', 'openrouter', 'haiku'],
    [
      'no matching route decodes the address segment',
      cfg,
      'or',
      'acme%2Fslug',
      'openrouter',
      'acme/slug',
    ],
    [
      'a disabled-only match still decodes rather than serving it',
      config({ routes: [disabled] }),
      'or',
      'org%2Fmodel',
      'openrouter',
      'org/model',
    ],
  ] as const)('%s', (_name, conf, engine, seg, upstream, want) => {
    expect(resolveUpstreamModelId(conf, engine, seg, upstream)).toBe(want)
  })
})

describe('claudeModelEnv', () => {
  test('every claude model var is the address segment, never a mixed default', () => {
    expect(claudeModelEnv('kimi-k2')).toEqual({
      ANTHROPIC_MODEL: 'kimi-k2',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2',
      CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k2',
    })
  })
})
