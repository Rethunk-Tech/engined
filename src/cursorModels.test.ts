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

  // For a base where a "-thinking" sibling and a plain sibling carry the SAME
  // effort word (`claude-sonnet-5-low` next to `claude-sonnet-5-thinking-low`),
  // both collapse onto one ladder rung and only the lowest-effort plain
  // sibling stays addressable there -- a real, deliberate loss of resolution
  // the flat reasoning_effort/service_tier pair cannot avoid. Every id in the
  // fixture is still checked: the ones that are not their base's canonical
  // pick for their own (level, fast) still resolve to a real, existing
  // sibling at that same level, never to nothing and never to a 4xx.
  let exact = 0
  let lossy = 0

  for (const id of FIXTURE_IDS) {
    const v = parseCursorModelId(id)
    const group = groups.get(v.base) as CursorBaseGroup
    const level = group.levelOf.get(id)
    test(`${id} resolves from its own (level=${level}, fast=${v.fast})`, () => {
      const picked = resolveCursorVariant(group, {
        reasoningEffort: level,
        serviceTier: v.fast ? 'priority' : 'auto',
      })
      expect(picked).toBeDefined()
      expect(group.levelOf.get((picked as { id: string }).id)).toBe(level)
      if (picked?.id === id) {
        exact += 1
      } else {
        lossy += 1
      }
    })
  }

  test('the great majority of the real catalog round-trips exactly', () => {
    expect(exact).toBeGreaterThan(FIXTURE_IDS.length * 0.8)
    expect(exact + lossy).toBe(FIXTURE_IDS.length)
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
