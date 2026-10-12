import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { pruneConfig } from './configPrune.ts'
import { ModelDiscovery } from './modelDiscovery.ts'
import { makeTestRoot } from './test-support.ts'

const ROOT = makeTestRoot('engined-prune-test-')
const ENGINES = join(import.meta.dir, '..', 'engines')

function row(id: string, display: string) {
  return {
    id,
    display_name: display,
    line: 'sonnet',
    created_at: '2026-09-28T00:00:00Z',
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: { image_input: { supported: true } },
  }
}

function discovery(status = 200): ModelDiscovery {
  const dir = mkdtempSync(join(ROOT, 'login-'))
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: Date.now() + 3_600_000 } }),
  )
  return new ModelDiscovery({
    stateRoot: mkdtempSync(join(ROOT, 'state-')),
    claudeDir: dir,
    env: {},
    log: () => undefined,
    fetch: async () =>
      status === 200
        ? Response.json({
            data: [
              row('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
              row('claude-opus-5-5', 'Claude Opus 5.5'),
            ],
            has_more: false,
          })
        : new Response('no', { status }),
  })
}

const MAIN = `# top comment
listen_port = 29200

[[engine]]
id = "claude"
agent_version = "1"

# keep: a real pin
[[model]]
id = "pinned"
input = ["text"]

[[model]]
id = "sonnet-5-5"
input = ["text", "image"]

# redundant with discovery
[[route]]
engine = "claude"
model = "sonnet-5-5"
wire_model = "claude-sonnet-5-5"
display_name = "Claude Sonnet 5.5"

# differs in one field (label)
[[route]]
engine = "claude"
model = "opus-5-5"
wire_model = "claude-opus-5-5"
display_name = "My Opus"

[[route]]
engine = "claude"
model = "pinned"
wire_model = "claude-opus-4-1"
`

function fixture(): { main: string; out: string } {
  const dir = mkdtempSync(join(ROOT, 'cfg-'))
  const main = join(dir, 'config.toml')
  writeFileSync(main, MAIN)
  return { main, out: join(mkdtempSync(join(ROOT, 'out-')), 'out.toml') }
}

test('removes redundant and retired routes, keeps a differing one, and keeps every other byte', async () => {
  const { main, out } = fixture()
  const result = await pruneConfig({
    file: main,
    out,
    enginesRoot: ENGINES,
    discovery: discovery(),
  })
  expect(result.removals.map((r) => `${r.kind}:${r.name}`).sort()).toEqual([
    'duplicate:sonnet-5-5',
    'model:pinned',
    'model:sonnet-5-5',
    'retired:pinned',
  ])
  const text = readFileSync(out, 'utf8')
  expect(text).toContain('# top comment')
  expect(text).toContain('# keep: a real pin')
  expect(text).toContain('model = "opus-5-5"')
  expect(text).not.toContain('wire_model = "claude-sonnet-5-5"')
  // A [[model]] goes with the last route that used it, and comments stay.
  expect(text).not.toContain('id = "sonnet-5-5"')
  expect(text).not.toContain('id = "pinned"')
})

test('prunes a config.d fragment and writes it beside the output', async () => {
  const { main, out } = fixture()
  const dir = join(main, '..', 'config.d')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'extra.toml'),
    '# fragment\n[[route]]\nengine = "claude"\nmodel = "sonnet-5-5"\nwire_model = "claude-sonnet-5-5"\n',
  )
  const noRoute = readFileSync(main, 'utf8').replace(/# redundant with discovery[\s\S]*?\n\n/, '')
  writeFileSync(main, noRoute)
  const result = await pruneConfig({
    file: main,
    out,
    enginesRoot: ENGINES,
    discovery: discovery(),
  })
  expect(result.removals.some((r) => r.kind === 'duplicate' && r.file.endsWith('extra.toml'))).toBe(
    true,
  )
  const fragment = readFileSync(join(out, '..', 'config.d', 'extra.toml'), 'utf8')
  expect(fragment).toBe('# fragment\n')
})

test('refuses, writing nothing, when a provider list cannot be fetched', async () => {
  const { main, out } = fixture()
  await expect(
    pruneConfig({ file: main, out, enginesRoot: ENGINES, discovery: discovery(401) }),
  ).rejects.toThrow('refusing to prune: the provider list for "claude" could not be fetched')
  expect(() => readFileSync(out, 'utf8')).toThrow()
})
