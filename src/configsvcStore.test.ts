import { expect, test } from 'bun:test'
import { unifiedDiff } from './configsvcStore.ts'

test('a small edit diffs line by line', () => {
  const diff = unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nX\ne\nf\ng\nh\n')
  expect(diff).toContain('-d')
  expect(diff).toContain('+X')
})

test('a huge differing block is replaced whole instead of building an LCS table', () => {
  const before = Array.from({ length: 30_000 }, (_, i) => `a${i}`).join('\n')
  const after = Array.from({ length: 30_000 }, (_, i) => `b${i}`).join('\n')
  const started = performance.now()
  const diff = unifiedDiff(before, after)
  expect(performance.now() - started).toBeLessThan(2000)
  expect(diff).toContain('-a0')
  expect(diff).toContain('+b29999')
})
