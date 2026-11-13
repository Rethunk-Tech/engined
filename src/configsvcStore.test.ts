import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHistory, readSnapshot, saveConfig, unifiedDiff } from './configsvcStore.ts'
import { ENGINES_ROOT, makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-store-')

test('a small edit diffs line by line', () => {
  const diff = unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nX\ne\nf\ng\nh\n')
  expect(diff).toContain('-d')
  expect(diff).toContain('+X')
})

test('a huge differing block is replaced whole instead of building an LCS table', () => {
  const before = Array.from({ length: 30_000 }, (_, i) => `a${i}`).join('\n')
  const after = Array.from({ length: 30_000 }, (_, i) => `b${i}`).join('\n')
  const started = performance.now()
  const diff = unifiedDiff(before, after)
  expect(performance.now() - started).toBeLessThan(2000)
  expect(diff).toContain('-a0')
  expect(diff).toContain('+b29999')
})

test('saving keeps the config file private', () => {
  const configFile = join(mkdtempSync(join(TEST_ROOT, 'save-')), 'config.toml')
  writeFileSync(configFile, 'listen_port = 29250\n')
  chmodSync(configFile, 0o600)
  const snap = readSnapshot(configFile)
  const out = saveConfig(
    { configFile, enginesRoot: ENGINES_ROOT, bunx: 'bunx' },
    `${snap.text}\n# x\n`,
    snap.sha256,
  )
  expect(out.ok).toBe(true)
  expect(statSync(configFile).mode & 0o777).toBe(0o600)
})

test('a well-formed history name with no file reads as absent, not a throw', () => {
  const configFile = join(mkdtempSync(join(TEST_ROOT, 'hist-')), 'config.toml')
  expect(readHistory(configFile, 'config-20260101T000000Z.toml')).toBeUndefined()
})
