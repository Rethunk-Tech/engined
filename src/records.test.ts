import { describe, expect, test } from 'bun:test'
import { errMessage, finiteNumber, isRecord, parseRecord } from './records.ts'

describe('finiteNumber', () => {
  test.each([
    [0, 0],
    [1.5, 1.5],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    ['12', undefined],
    [null, undefined],
    [undefined, undefined],
  ] as const)('%j', (v, want) => {
    expect(finiteNumber(v)).toBe(want)
  })
})

describe('isRecord', () => {
  test.each([
    [{ a: 1 }, true],
    [[1], false],
    [null, false],
    ['x', false],
  ] as const)('%j', (v, want) => {
    expect(isRecord(v)).toBe(want)
  })
})

describe('parseRecord', () => {
  test.each([
    ['{"a":1}', { a: 1 }],
    ['[1]', null],
    ['not json', null],
    ['"str"', null],
  ] as const)('%j', (text, want) => {
    expect(parseRecord(text)).toEqual(want)
  })
})

describe('errMessage', () => {
  test.each([
    [new Error('boom'), 'boom'],
    ['plain', 'plain'],
    [12, '12'],
  ] as const)('%j', (err, want) => {
    expect(errMessage(err)).toBe(want)
  })
})
