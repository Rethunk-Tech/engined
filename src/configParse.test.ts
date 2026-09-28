/**
 * `config.test.ts` already drives most of this module's error paths through
 * `loadConfig()` end to end -- unrecognised keys, array shape, the
 * setTimeout ceiling, positive-integer checks, and the XDG tilde prefix are
 * all covered there. This fills the two pure-function gaps nothing else
 * reaches directly: `asArgs` refusing a non-table, and `mergeCapabilities`'
 * layer order.
 */
import { describe, expect, test } from 'bun:test'
import { asArgs, mergeCapabilities } from './configParse.ts'
import { ParseError } from './errors/parse.ts'

describe('asArgs', () => {
  test('a table of scalars passes through unchanged', () => {
    expect(asArgs({ ngl: 99, verbose: true, name: 'x' }, 'route "e"', 'f.toml')).toEqual({
      ngl: 99,
      verbose: true,
      name: 'x',
    })
  })

  test('a non-table value is refused rather than silently reaching the engine as [object Object]', () => {
    expect(() => asArgs(['not', 'a', 'table'], 'route "e"', 'f.toml')).toThrow(
      /route "e" "args" must be a table/,
    )
    expect(() => asArgs(['x'], 'route "e"', 'f.toml')).toThrow(ParseError)
  })

  test('absent args is an empty table, not an error', () => {
    expect(asArgs(undefined, 'route "e"', 'f.toml')).toEqual({})
  })
})

describe('mergeCapabilities', () => {
  test('a later layer overrides an earlier one field by field, never wholesale', () => {
    const base = { input: ['text'], context_in: 8192 }
    const role = { input: ['text', 'image'] }
    const route = { context_in: 4096 }
    expect(mergeCapabilities(base, role, route)).toEqual({
      input: ['text', 'image'],
      context_in: 4096,
    })
  })

  test('a field absent from every layer stays absent', () => {
    expect(mergeCapabilities({ input: ['text'] }, {})).toEqual({ input: ['text'] })
  })
})
