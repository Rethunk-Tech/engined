import { describe, expect, test } from 'bun:test'
import {
  addressForRoute,
  LOCAL_UPSTREAM,
  localRoutesOf,
  qualifiedSegments,
  siblingRouteCount,
} from './routeAddress.ts'
import { route } from './test-support.ts'

describe('qualifiedSegments', () => {
  test.each([
    ['plain-id', undefined],
    ['@/', undefined],
    ['@/a/', undefined],
    ['@/one', ['one']],
    ['@/engine/model', ['engine', 'model']],
    ['@/engine/up/model', ['engine', 'up', 'model']],
    ['@/engine/up/model/extra', undefined],
    ['@engine/model', undefined],
  ] as const)('%s', (model, segs) => {
    expect(qualifiedSegments(model)).toEqual(segs === undefined ? undefined : [...segs])
  })
})

describe('siblingRouteCount', () => {
  const a = route({ engine: 'e', model: 'm', upstream: 'local' })
  const b = route({ engine: 'e', model: 'm', upstream: 'remote' })
  const other = route({ engine: 'e', model: 'n', upstream: 'local' })
  const disabled = { ...b, disabled: true }
  const modelless = route({ engine: 'agent', model: undefined, upstream: 'local' })

  test.each([
    ['a modelless route is never ambiguous', modelless, [modelless], 1],
    ['one served claim is one sibling', a, [a], 1],
    ['two served claims of the same pair', a, [a, b], 2],
    ['a disabled sibling is not counted', a, [a, disabled], 1],
    ['a different model is not a sibling', a, [a, other], 1],
  ] as const)('%s', (_name, subject, routes, n) => {
    expect(siblingRouteCount(subject, routes)).toBe(n)
  })
})

describe('addressForRoute', () => {
  test.each([
    [
      'the only claim of a pair is two-segment',
      { engine: 'e', model: 'm', upstream: 'local' as const },
      1,
      '@/e/m',
    ],
    [
      'siblings on a keyed upstream are three-segment',
      { engine: 'e', model: 'm', upstream: 'or' as const },
      2,
      '@/e/or/m',
    ],
    [
      'an ambient sibling still uses two segments',
      { engine: 'e', model: 'm', upstream: null },
      2,
      '@/e/m',
    ],
    [
      'a modelless route is engine/upstream',
      { engine: 'claude', model: undefined, upstream: 'anthropic' as const },
      1,
      '@/claude/anthropic',
    ],
  ] as const)('%s', (_name, r, siblings, address) => {
    expect(addressForRoute(r, siblings)).toBe(address)
  })
})

describe('localRoutesOf', () => {
  const local = route({ engine: 'llama', model: 'a', upstream: LOCAL_UPSTREAM })
  const remote = route({ engine: 'llama', model: 'b', upstream: 'or' })
  const other = route({ engine: 'comfy', model: 'c', upstream: LOCAL_UPSTREAM })

  test('keeps this engine on this box and drops the rest', () => {
    expect(localRoutesOf([local, remote, other], 'llama')).toEqual([local])
  })
})
