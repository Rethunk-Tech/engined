import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from './config.ts'
import { ENGINES_ROOT, makeTestRoot } from './test-support.ts'
import { addEntry, dependents, removeEntry, renameIdIn, setKey } from './tomlEdit.ts'

const TEST_ROOT = makeTestRoot('engined-tomledit-')
const EXAMPLE = readFileSync(join(import.meta.dir, '..', 'config.example.toml'), 'utf8')

const lines = (text: string) => text.split('\n')

test('setKey changes exactly one line, comments and all', () => {
  const out = setKey(EXAMPLE, ['listen_port'], 29_250)
  const before = lines(EXAMPLE)
  const after = lines(out)
  expect(after).toHaveLength(before.length)
  const changed = after.flatMap((line, i) => (line === before[i] ? [] : [line]))
  expect(changed).toEqual(['listen_port = 29250 # IANA-unassigned.'])
})

test('adding then removing a route leaves every other line byte-identical', () => {
  const routes = (Bun.TOML.parse(EXAMPLE) as { route: unknown[] }).route.length
  const added = addEntry(EXAMPLE, 'route', {
    engine: 'kokoro',
    upstream: 'local',
    args: { speed: 1 },
  })
  const beforeLines = lines(EXAMPLE)
  let cursor = 0
  for (const line of lines(added)) {
    if (line === beforeLines[cursor]) {
      cursor++
    }
  }
  expect(cursor).toBe(beforeLines.length)
  expect(removeEntry(added, 'route', routes)).toBe(EXAMPLE)
})

/** The example with its models_dir swapped for a scratch dir of empty placeholders, written as a config. */
function loadable(text: string): string {
  const models = mkdtempSync(join(TEST_ROOT, 'models-'))
  for (const [, rel] of text.matchAll(/filename\s*=\s*"([^"]+)"/g)) {
    const full = join(models, rel as string)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, '')
  }
  const path = join(mkdtempSync(join(TEST_ROOT, 'config-')), 'config.toml')
  writeFileSync(
    path,
    text.replace(
      /models_dir\s*=\s*"~\/\.local\/share\/engined-models\/[a-z]+"/g,
      `models_dir = "${models}"`,
    ),
  )
  return path
}

test('renaming an engine rewrites every reference and the result still loads', () => {
  const refs = dependents(EXAMPLE, 'engine', 'llama')
  expect(refs).toEqual(expect.arrayContaining(['route[0].engine']))
  expect(refs.some((ref) => ref.startsWith('chain['))).toBe(true)
  expect(refs.some((ref) => ref.endsWith('wire_model'))).toBe(true)

  // An engine id names its spec directory, so a plain engine refuses; one with spec_dir renames freely.
  expect(() => renameIdIn(EXAMPLE, 'engine', 'llama', 'llama2')).toThrow(
    'takes its spec from engines/llama',
  )
  const engines = join(mkdtempSync(join(TEST_ROOT, 'engines-')), 'engines')
  cpSync(ENGINES_ROOT, engines, { recursive: true })
  const pinned = setKey(EXAMPLE, ['engine', 0, 'spec_dir'], join(engines, 'llama'))
  const out = renameIdIn(pinned, 'engine', 'llama', 'llama2')
  expect(dependents(out, 'engine', 'llama')).toEqual([])
  expect(dependents(out, 'engine', 'llama2')).toEqual(refs)

  const cfg = loadConfig(loadable(out), engines)
  expect(cfg.engines.map((e) => e.id)).toContain('llama2')
  expect(cfg.engines.map((e) => e.id)).not.toContain('llama')
  expect(() => renameIdIn(EXAMPLE, 'engine', 'llama', 'whisper')).toThrow('already exists')
})
