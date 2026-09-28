import { expect, test } from 'bun:test'
import { ParseError } from './parse.ts'

test('ParseError puts the file in the message and does not keep a file field', () => {
  const err = new ParseError('invalid TOML', '/tmp/config.toml')
  expect(err.message).toBe('/tmp/config.toml: invalid TOML')
  expect(Object.hasOwn(err, 'file')).toBe(false)
})
