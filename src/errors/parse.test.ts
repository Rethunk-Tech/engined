import { expect, test } from 'bun:test'
import { ParseError } from './parse.ts'

test('ParseError puts the file in the message and does not keep a file field', () => {
  const err = new ParseError('invalid TOML', '/tmp/config.toml')
  expect(err.message).toBe('/tmp/config.toml: invalid TOML')
  expect(Object.hasOwn(err, 'file')).toBe(false)
})

test.each([
  [
    'a file string prefixes the message',
    () => new ParseError('bad', '/tmp/a.toml'),
    '/tmp/a.toml: bad',
    { file: '/tmp/a.toml' },
  ],
  [
    'a ConfigPath prefixes from its file and is kept',
    () => new ParseError('bad', { file: '/tmp/a.toml', table: 'route', index: 0, key: 'model' }),
    '/tmp/a.toml: bad',
    { file: '/tmp/a.toml', table: 'route', index: 0, key: 'model' },
  ],
  [
    'ErrorOptions.path is recorded without rewriting the message',
    () => new ParseError('bad', { path: { file: '/tmp/a.toml' } }),
    'bad',
    { file: '/tmp/a.toml' },
  ],
  ['no second argument is a bare message', () => new ParseError('bad'), 'bad', undefined],
] as const)('%s', (_name, make, message, path) => {
  const err = make()
  expect(err.message).toBe(message)
  expect(err.path).toEqual(path)
})
