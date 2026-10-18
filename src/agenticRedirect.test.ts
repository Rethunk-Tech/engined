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
    {
      name: 'empty segment',
      conf: cfg,
      engine: 'or',
      seg: '',
      upstream: undefined,
      want: undefined,
    },
    {
      name: 'wildcard sentinel',
      conf: cfg,
      engine: 'or',
      seg: '*',
      upstream: undefined,
      want: undefined,
    },
    {
      name: 'a route with wire_model yields the wire id',
      conf: cfg,
      engine: 'or',
      seg: 'org%2Fmodel',
      upstream: 'openrouter',
      want: 'org/model',
    },
    {
      name: 'a route without wire_model yields the model',
      conf: cfg,
      engine: 'or',
      seg: 'haiku',
      upstream: 'openrouter',
      want: 'haiku',
    },
    {
      name: 'no matching route decodes the address segment',
      conf: cfg,
      engine: 'or',
      seg: 'acme%2Fslug',
      upstream: 'openrouter',
      want: 'acme/slug',
    },
    {
      name: 'a disabled-only match still decodes rather than serving it',
      conf: config({ routes: [disabled] }),
      engine: 'or',
      seg: 'org%2Fmodel',
      upstream: 'openrouter',
      want: 'org/model',
    },
  ])('$name', ({ conf, engine, seg, upstream, want }) => {
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
