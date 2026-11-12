import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { asEnv, parsePort, parsePositiveInteger } from './configParse.ts'
import { ParseError } from './errors/parse.ts'

const PORT_MAX = 65_535
const LABEL = 'route[0] "port"'
const FILE = 'config.toml'

test('parsePort: integer 1–65535 is returned unchanged', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: PORT_MAX }), (n) => {
      expect(parsePort(n, LABEL, FILE, 8080)).toBe(n)
    }),
  )
})

test('parsePort: undefined yields the fallback', () => {
  fc.assert(
    fc.property(fc.integer(), (fallback) => {
      expect(parsePort(undefined, LABEL, FILE, fallback)).toBe(fallback)
    }),
  )
})

test('parsePort: non-ports throw ParseError, never another error', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer().filter((n) => n < 1 || n > PORT_MAX),
        fc.double({ noInteger: true, noNaN: true }),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        fc.string(),
        fc.boolean(),
        fc.constant(null),
        fc.array(fc.integer()),
      ),
      (v) => {
        expect(() => parsePort(v, LABEL, FILE, 8080)).toThrow(ParseError)
      },
    ),
  )
})

test('parsePositiveInteger: positive integers are returned unchanged', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (n) => {
      expect(parsePositiveInteger(n, LABEL, FILE, 4)).toBe(n)
    }),
  )
})

test('parsePositiveInteger: undefined yields the fallback', () => {
  fc.assert(
    fc.property(fc.integer(), (fallback) => {
      expect(parsePositiveInteger(undefined, LABEL, FILE, fallback)).toBe(fallback)
    }),
  )
})

test('parsePositiveInteger: non-positive-integers throw ParseError', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({ max: 0 }),
        fc.double({ noInteger: true, noNaN: true }),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        fc.string(),
        fc.boolean(),
        fc.constant(null),
      ),
      (v) => {
        expect(() => parsePositiveInteger(v, LABEL, FILE, 4)).toThrow(ParseError)
      },
    ),
  )
})

const envKey = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'),
    fc.stringMatching(/^[A-Za-z0-9_]*$/),
  )
  .map(([head, rest]) => head + rest)

test('asEnv: valid KEY=VALUE tables round-trip', () => {
  fc.assert(
    fc.property(fc.dictionary(envKey, fc.string()), (table) => {
      expect(asEnv(table, 'engine[0]', FILE)).toEqual(table)
    }),
  )
})

test('asEnv: undefined stays absent', () => {
  expect(asEnv(undefined, 'engine[0]', FILE)).toBeUndefined()
})

test('asEnv: non-tables, bad keys, and non-string values throw ParseError', () => {
  const badKey = fc.string().filter((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constantFrom(null, 1, 'env', true, []),
        fc.dictionary(badKey, fc.string()).filter((t) => Object.keys(t).length > 0),
        fc
          .dictionary(envKey, fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)))
          .filter((t) => Object.keys(t).length > 0),
      ),
      (v) => {
        expect(() => asEnv(v, 'engine[0]', FILE)).toThrow(ParseError)
      },
    ),
  )
})
