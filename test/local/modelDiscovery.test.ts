import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

import { ModelDiscovery } from '../../src/modelDiscovery.ts'
import { config, engine, makeTestRoot } from '../../src/test-support.ts'

/** The real Models API with this box's Claude login, and the real `cursor-agent --list-models`. */
const ROOT = makeTestRoot('engined-discovery-local-')

test('the Claude login lists models with image input and a default', async () => {
  const log: string[] = []
  const d = new ModelDiscovery({ stateRoot: mkdtempSync(join(ROOT, 's-')), log: (l) => log.push(l) })
  await d.refresh('claude')
  expect(log[0]).toMatch(/^models: claude: found \d+/)
  const view = d.apply(config({ engines: [engine({ id: 'claude' })], routes: [] }))
  expect(view.routes.length).toBeGreaterThan(0)
  expect(view.routes.every((r) => r.input?.includes('image'))).toBe(true)
  expect(view.default_models?.claude).toMatch(/^sonnet-/)
})

test('cursor-agent lists models, one of them the provider default', async () => {
  const log: string[] = []
  const d = new ModelDiscovery({ stateRoot: mkdtempSync(join(ROOT, 's-')), log: (l) => log.push(l) })
  await d.refresh('cursor')
  expect(log[0]).toMatch(/^models: cursor: found \d+/)
  const view = d.apply(config({ engines: [engine({ id: 'cursor' })], routes: [] }))
  expect(view.default_models?.cursor).toBe('auto')
})
