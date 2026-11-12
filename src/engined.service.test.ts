import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('user unit caps RSS and forbids swap', () => {
  const unit = readFileSync(join(import.meta.dir, '../scripts/engined.service.in'), 'utf8')
  expect(unit).toMatch(/MemoryMax=\d+M/)
  expect(unit).toContain('MemorySwapMax=0')
})
