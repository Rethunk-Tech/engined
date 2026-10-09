import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropRoutesWithFilename, loadConfigWithoutMissingWeights } from './localConfigPrune.ts'

const TOML = `listen_port = 1

[[route]]
engine = "llama"
model = "keep"
filename = "a/keep.gguf"
role = "chat"

[[route]]
engine = "llama"
model = "gone"
filename = "b/gone.gguf"
role = "rerank"

[route.args]
rerank = true

[[route]]
engine = "llama"
model = "tail"
filename = "c/tail.gguf"
`

test('dropRoutesWithFilename removes only the named route and its sub-table', () => {
  const { toml, dropped } = dropRoutesWithFilename(TOML, 'b/gone.gguf')
  expect(dropped).toBe(1)
  expect(toml).toContain('keep.gguf')
  expect(toml).toContain('tail.gguf')
  expect(toml).not.toContain('gone')
  expect(toml).not.toContain('rerank = true')
})

test('dropRoutesWithFilename is a no-op for a filename no route names', () => {
  expect(dropRoutesWithFilename(TOML, 'nope.gguf')).toEqual({ toml: TOML, dropped: 0 })
})

test('loadConfigWithoutMissingWeights keeps routes whose weights exist and names the missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engined-prune-'))
  const models = join(dir, 'models')
  mkdirSync(join(models, 'a'), { recursive: true })
  writeFileSync(join(models, 'a', 'keep.gguf'), '')
  const file = join(dir, 'config.toml')
  writeFileSync(
    file,
    `[[upstream]]
id = "local"
egress = "none"

[[engine]]
id = "llama"
models_dir = "${models}"

[[route]]
engine = "llama"
upstream = "local"
model = "keep"
filename = "a/keep.gguf"
role = "chat"

[[route]]
engine = "llama"
upstream = "local"
model = "gone"
filename = "b/gone.gguf"
role = "rerank"
`,
  )
  const enginesRoot = join(import.meta.dir, '..', 'engines')
  const { config, missing } = loadConfigWithoutMissingWeights(file, enginesRoot)
  expect(config.routes.map((r) => r.model)).toEqual(['keep'])
  expect(missing).toEqual([join(models, 'b', 'gone.gguf')])
  expect(readdirSync(dir).filter((n) => n.startsWith('.pruned-'))).toEqual([])
})

test('loadConfigWithoutMissingWeights rethrows an error that is not a missing weights file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engined-prune-'))
  const file = join(dir, 'config.toml')
  writeFileSync(file, 'not = [valid')
  expect(() =>
    loadConfigWithoutMissingWeights(file, join(import.meta.dir, '..', 'engines')),
  ).toThrow()
})
