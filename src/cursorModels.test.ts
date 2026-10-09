import { describe, expect, test } from 'bun:test'
import {
  CURSOR_EFFORT_ORDER,
  type CursorBaseGroup,
  cursorBaseDisplayName,
  groupCursorModels,
  parseCursorModelId,
  representativeVariant,
  resolveCursorVariant,
} from './cursorModels.ts'
import { CURSOR_MODEL_FIXTURE } from './cursorModelsFixture.ts'

const FIXTURE_IDS = CURSOR_MODEL_FIXTURE.map(([id]) => id)
const DISPLAY_NAME_OF = new Map(CURSOR_MODEL_FIXTURE)

describe('groupCursorModels', () => {
  test('collapses the real 241-id catalog onto roughly one row per base model', () => {
    const groups = groupCursorModels(FIXTURE_IDS)
    // ~43 in the door's own estimate; the real catalog groups to 39 -- a
    // handful of "43" are Cursor's own base+size variants (mini, nano) that
    // are genuinely different models, not reasoning-effort siblings.
    expect(groups.size).toBeGreaterThan(30)
    expect(groups.size).toBeLessThan(50)
  })

  test('every fixture id lands in exactly one group', () => {
    const groups = groupCursorModels(FIXTURE_IDS)
    const seen = new Set<string>()
    for (const group of groups.values()) {
      for (const v of group.variants) {
        expect(seen.has(v.id)).toBe(false)
        seen.add(v.id)
      }
    }
    expect(seen.size).toBe(FIXTURE_IDS.length)
  })

  test('a single-variant base (no reasoning choice) reports no reasoning capability', () => {
    const groups = groupCursorModels(FIXTURE_IDS)
    expect(groups.get('auto')?.variants).toHaveLength(1)
    expect(groups.get('auto')?.reasoning).toBeUndefined()
  })

  test('a base with both -thinking and plain effort siblings collapses the plain ones onto "none"', () => {
    const groups = groupCursorModels(FIXTURE_IDS)
    const sonnet5 = groups.get('claude-sonnet-5') as CursorBaseGroup
    expect(sonnet5.reasoning).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('hasThinkingAxis is true only for a base with a plain/-thinking pair at the same word', () => {
    const groups = groupCursorModels(FIXTURE_IDS)
    // claude-sonnet-5-high and claude-sonnet-5-thinking-high share "high".
    expect((groups.get('claude-sonnet-5') as CursorBaseGroup).hasThinkingAxis).toBe(true)
    // gpt-5.4-mini has no -thinking sibling at all.
    expect((groups.get('gpt-5.4-mini') as CursorBaseGroup).hasThinkingAxis).toBe(false)
  })

  test('a base with no -thinking sibling at all keeps its own effort words as the ladder', () => {
    const groups = groupCursorModels(FIXTURE_IDS)
    const mini = groups.get('gpt-5.4-mini') as CursorBaseGroup
    expect(mini.reasoning).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
  })
})

describe('parseCursorModelId', () => {
  test('reads the reasoning-then-thinking order (opus-4-7 family)', () => {
    expect(parseCursorModelId('claude-opus-4-7-thinking-high-fast')).toEqual({
      id: 'claude-opus-4-7-thinking-high-fast',
      base: 'claude-opus-4-7',
      thinking: true,
      effort: 'high',
      fast: true,
    })
  })

  test('reads the thinking-then-reasoning order (opus-4.5 family)', () => {
    expect(parseCursorModelId('claude-4.5-opus-high-thinking')).toEqual({
      id: 'claude-4.5-opus-high-thinking',
      base: 'claude-4.5-opus',
      thinking: true,
      effort: 'high',
      fast: false,
    })
  })

  test('a base name that happens to spell an effort word is not stripped from the wrong position', () => {
    expect(parseCursorModelId('gpt-5.3-codex-low').base).toBe('gpt-5.3-codex')
    expect(parseCursorModelId('kimi-k2.7-code')).toEqual({
      id: 'kimi-k2.7-code',
      base: 'kimi-k2.7-code',
      thinking: false,
      effort: undefined,
      fast: false,
    })
  })
})

describe('resolveCursorVariant: exact multi-suffix round trip', () => {
  const groups = groupCursorModels(FIXTURE_IDS)

  // The collapsed ladder alone (reasoning_effort + service_tier) cannot tell
  // a plain sibling apart from a "-thinking" one that shares its effort word
  // (`claude-sonnet-5-low` next to `claude-sonnet-5-thinking-low`) -- that is
  // exactly what the `thinking` request field breaks the tie on. Sent
  // alongside its own (base, level, fast), every one of the 241 real ids
  // round-trips to itself exactly, with no lossy remainder.
  for (const id of FIXTURE_IDS) {
    const v = parseCursorModelId(id)
    const group = groups.get(v.base) as CursorBaseGroup
    // The variant's own effort word, never the collapsed ladder position --
    // `thinking` disambiguates within it, so the request names the word the
    // id itself carries, not the "none" a plain sibling collapses onto.
    const naturalLevel = v.effort ?? 'medium'
    test(`${id} resolves from its own (level=${naturalLevel}, thinking=${v.thinking}, fast=${v.fast})`, () => {
      const picked = resolveCursorVariant(group, {
        reasoningEffort: naturalLevel,
        serviceTier: v.fast ? 'priority' : 'auto',
        thinking: v.thinking,
      })
      expect(picked).toBeDefined()
      expect(picked?.id).toBe(id)
    })
  }

  test('every one of the 241 real ids round-trips exactly', () => {
    const exact = FIXTURE_IDS.filter((id) => {
      const v = parseCursorModelId(id)
      const group = groups.get(v.base) as CursorBaseGroup
      return (
        resolveCursorVariant(group, {
          reasoningEffort: v.effort ?? 'medium',
          serviceTier: v.fast ? 'priority' : 'auto',
          thinking: v.thinking,
        })?.id === id
      )
    })
    expect(exact).toHaveLength(FIXTURE_IDS.length)
  })
})

describe('resolveCursorVariant: the thinking axis', () => {
  const groups = groupCursorModels(FIXTURE_IDS)
  const sonnet5 = groups.get('claude-sonnet-5') as CursorBaseGroup

  test('thinking: true and thinking: false pick different siblings at the same effort word', () => {
    const thinking = resolveCursorVariant(sonnet5, { reasoningEffort: 'high', thinking: true })
    const plain = resolveCursorVariant(sonnet5, { reasoningEffort: 'high', thinking: false })
    expect(thinking?.id).toBe('claude-sonnet-5-thinking-high')
    expect(plain?.id).toBe('claude-sonnet-5-high')
  })

  test('thinking absent still collapses the plain sibling onto "none", unchanged from before this axis existed', () => {
    expect(resolveCursorVariant(sonnet5, { reasoningEffort: 'high' })?.id).toBe(
      'claude-sonnet-5-thinking-high',
    )
  })

  test('a thinking request for an axis the base does not have falls through to the ordinary pick', () => {
    // gpt-5.4-mini has no -thinking sibling at all -- thinking: true names an
    // axis that does not exist here, so it must not refuse.
    const mini = groups.get('gpt-5.4-mini') as CursorBaseGroup
    const picked = resolveCursorVariant(mini, { reasoningEffort: 'high', thinking: true })
    expect(picked).toBeDefined()
    expect(picked?.id).toBe('gpt-5.4-mini-high')
  })
})

describe('resolveCursorVariant: defaults and nearest-level fallback', () => {
  const groups = groupCursorModels(FIXTURE_IDS)

  test("no reasoning_effort picks the base's own unsuffixed variant when it has one", () => {
    const codex = groups.get('gpt-5.3-codex') as CursorBaseGroup
    expect(resolveCursorVariant(codex, {})?.id).toBe('gpt-5.3-codex')
  })

  test('no reasoning_effort falls back to "medium" when the base has no unsuffixed variant', () => {
    // claude-opus-5 has no bare id at all, so absent defaults to level
    // "medium" -- which only its -thinking sibling occupies, since the
    // plain "-medium" sibling collapses onto "none" (it has a -thinking
    // sibling of its own alongside it).
    const opus5 = groups.get('claude-opus-5') as CursorBaseGroup
    expect(resolveCursorVariant(opus5, {})?.id).toBe('claude-opus-5-thinking-medium')
  })

  test('service_tier "priority" selects the -fast sibling', () => {
    const codex = groups.get('gpt-5.3-codex') as CursorBaseGroup
    expect(resolveCursorVariant(codex, { serviceTier: 'priority' })?.id).toBe('gpt-5.3-codex-fast')
  })

  test('a level with no offered variant walks to the nearest one on the ladder', () => {
    // claude-4.6-opus offers only none/high/max -- asking for "low" (between
    // none and high) must land on whichever is nearer, not refuse.
    const opus46 = groups.get('claude-4.6-opus') as CursorBaseGroup
    expect(opus46.reasoning).toEqual(['none', 'high', 'max'])
    const picked = resolveCursorVariant(opus46, { reasoningEffort: 'low' })
    expect(picked).toBeDefined()
    const level = opus46.levelOf.get((picked as { id: string }).id) as string
    expect(['none', 'high']).toContain(level)
  })

  test('a fast request with no fast sibling falls back to the non-fast one', () => {
    // "high" only matches the -thinking sibling here (the plain "-high" id
    // collapses onto "none"), and that family has no -fast variant at all.
    const opus46 = groups.get('claude-4.6-opus') as CursorBaseGroup
    const picked = resolveCursorVariant(opus46, {
      reasoningEffort: 'high',
      serviceTier: 'priority',
    })
    expect(picked?.id).toBe('claude-4.6-opus-high-thinking')
  })

  test('every level word is a real rung on the documented ladder', () => {
    expect(CURSOR_EFFORT_ORDER).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })
})

describe('cursorBaseDisplayName', () => {
  test("uses the unsuffixed variant's own name verbatim when one exists", () => {
    const groups = groupCursorModels(FIXTURE_IDS)
    const codex = groups.get('gpt-5.3-codex') as CursorBaseGroup
    expect(
      cursorBaseDisplayName(codex.variants, (id) => DISPLAY_NAME_OF.get(id), 'gpt-5.3-codex'),
    ).toBe('Codex 5.3')
  })

  test('strips the trailing reasoning word when no unsuffixed variant exists', () => {
    const groups = groupCursorModels(FIXTURE_IDS)
    const opus5 = groups.get('claude-opus-5') as CursorBaseGroup
    expect(representativeVariant(opus5.variants).id).toBe('claude-opus-5-low')
    expect(
      cursorBaseDisplayName(opus5.variants, (id) => DISPLAY_NAME_OF.get(id), 'claude-opus-5'),
    ).toBe('Claude Opus 5 1M')
  })
})
