import { expect, test } from 'bun:test'
import { compileExclude, excludeMatcher } from './modelExclude.ts'

test('globs match the whole id; /regex/ entries are unanchored', () => {
  const table: [string, string, boolean][] = [
    ['openai/*', 'openai/gpt-5', true],
    ['openai/*', 'xopenai/gpt-5', false],
    ['*', 'a/b/c', true],
    ['gpt-?', 'gpt-4', true],
    ['gpt-?', 'gpt-45', false],
    ['gpt-4.1', 'gpt-4x1', false],
    ['gpt-4.1', 'gpt-4.1', true],
    ['/:free$/', 'org/model:free', true],
    ['/:free$/', 'org/model:free2', false],
  ]
  for (const [entry, id, want] of table) {
    expect(excludeMatcher([entry])(id)).toBe(want)
  }
})

test('an invalid regex or empty entry is refused; no entries exclude nothing', () => {
  expect(compileExclude('/(/')).toHaveProperty('error')
  expect(compileExclude('')).toHaveProperty('error')
  expect(excludeMatcher(undefined)('x')).toBe(false)
})
