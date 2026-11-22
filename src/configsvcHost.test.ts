/**
 * The hop secret in front of the config UI's bridged `X-Forwarded-For`: an
 * empty one must never authenticate a caller that sent no header at all.
 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureBridgeHop, hopMatches } from './configsvcHost.ts'

const scratch = () => join(mkdtempSync(join(tmpdir(), 'engined-hop-')), 'caddy', 'configsvc-hop')

test('an empty hop file is replaced with a real secret rather than handed back', () => {
  const file = scratch()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '   \n')

  const hop = ensureBridgeHop(file)
  expect(hop).toHaveLength(64)
  expect(readFileSync(file, 'utf8')).toBe(`${hop}\n`)
  expect(ensureBridgeHop(file)).toBe(hop)
})

test('an empty secret or empty header is never a match', () => {
  expect(hopMatches('', '')).toBe(false)
  expect(hopMatches('', 'abc')).toBe(false)
  expect(hopMatches('abc', '')).toBe(false)
  expect(hopMatches(undefined, 'abc')).toBe(false)
  expect(hopMatches('abc', 'abc')).toBe(true)
})
