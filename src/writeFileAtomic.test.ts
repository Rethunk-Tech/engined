import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './paths.ts'
import { makeTestRoot } from './test-support.ts'

const ROOT = makeTestRoot('engined-atomic-')

test('creates parents, replaces the file whole, and leaves no temp file behind', () => {
  const path = join(ROOT, 'a', 'b', 'state.json')
  writeFileAtomic(path, 'one\n')
  writeFileAtomic(path, 'two\n')
  expect(readFileSync(path, 'utf8')).toBe('two\n')
  expect(existsSync(`${path}.tmp`)).toBe(false)
})

test('a stale temp file from a crashed write does not stop the next write', () => {
  const path = join(ROOT, 'c', 'state.json')
  mkdirSync(join(ROOT, 'c'))
  writeFileAtomic(`${path}.tmp`, 'torn')
  writeFileAtomic(path, 'whole\n')
  expect(readFileSync(path, 'utf8')).toBe('whole\n')
})
