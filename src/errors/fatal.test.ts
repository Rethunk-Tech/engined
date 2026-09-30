import { describe, expect, test } from 'bun:test'
import { FatalError } from './fatal.ts'
import { ParseError } from './parse.ts'

describe('FatalError', () => {
  test('forwards cause to Error.cause', () => {
    const inner = new TypeError('boom')
    const outer = new FatalError('wrap', { cause: inner })
    expect(outer.cause).toBe(inner)
  })
})

describe('ParseError', () => {
  test('forwards cause through FatalError', () => {
    const inner = new SyntaxError('bad')
    const outer = new ParseError('invalid TOML', '/tmp/x.toml', { cause: inner })
    expect(outer.cause).toBe(inner)
  })
})
