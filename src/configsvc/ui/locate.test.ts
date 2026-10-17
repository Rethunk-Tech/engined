import { expect, test } from 'bun:test'
import { locate } from './locate.ts'

const text =
  '# c\n[[engine]]\nid = "a"\n[[route]]\nengine = "a"\nbogus = 1\n[[route]]\nengine = "a"\nbogus = 2\n'

test('a problem lands on its exact position, or the keyed line, or the entry header', () => {
  const at = locate(text, { message: 'x', line: 3, column: 6 })
  expect(text.slice(at.from, at.to)).toBe('"')
  const keyed = locate(text, { message: 'x', path: { table: 'route', index: 1, key: 'bogus' } })
  expect(text.slice(keyed.from, keyed.to)).toBe('bogus = 2')
  const header = locate(text, { message: 'x', path: { table: 'route', index: 0, key: 'missing' } })
  expect(text.slice(header.from, header.to)).toBe('[[route]]')
  expect(locate(text, { message: 'x' })).toEqual({ from: 0, to: 3 })
})
