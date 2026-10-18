/**
 * Docs vs the surfaces they describe: CLI flags, closed config keys, door
 * paths. A key or flag that ships without a mention here is the same class
 * of silent miss as an undocumented TOML key.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_TABLES } from './configSchema.ts'
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_COMPLETIONS,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGE_EDITS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  OPENAI_MODELS_PATH,
} from './routeServes.ts'
import { ENGINED_ENGINES_PATH, USAGE_PATH } from './usage.ts'

const ROOT = join(import.meta.dir, '..')
const FLAG_RE = /--[a-z][a-z0-9-]*/g
/** Array tables are `[[engine]]`; singleton tables are `[potluck]`. */
const TABLE_KEYS = new Set([
  'engine',
  'upstream',
  'model',
  'route',
  'chain',
  'potluck',
  'configsvc',
])

const DOOR_PATHS = [
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_COMPLETIONS,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGE_EDITS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  OPENAI_MODELS_PATH,
  `${OPENAI_MODELS_PATH}/{id}`,
  ENGINED_ENGINES_PATH,
  `${ENGINED_ENGINES_PATH}/events`,
  `${ENGINED_ENGINES_PATH}/:id/stop`,
  `${ENGINED_ENGINES_PATH}/:id/release`,
  `${ENGINED_ENGINES_PATH}/:id/hold`,
  `${ENGINED_ENGINES_PATH}/:id/unhold`,
  `${ENGINED_ENGINES_PATH}/:id/obtain`,
  `${ENGINED_ENGINES_PATH}/:id/logs`,
  `${ENGINED_ENGINES_PATH}/:id/resources`,
  `${ENGINED_ENGINES_PATH}/:id/tokenize`,
  `${ENGINED_ENGINES_PATH}/:id/apply-template`,
  '/engined/v1/start',
  '/engined/v1/tokenize',
  '/engined/v1/detokenize',
  '/engined/v1/audio/voices',
  '/engined/v1/images/:id',
  '/engined/v1/comfy/:engine/:upstream/...',
  '/engined/v1/upstreams/:id/refresh',
  USAGE_PATH,
]

test('HUMANS.md names every CLI flag --help prints', () => {
  const help = readFileSync(join(ROOT, 'src/extraModes.ts'), 'utf8')
  const humans = readFileSync(join(ROOT, 'HUMANS.md'), 'utf8')
  const flags = [...new Set(help.match(FLAG_RE) ?? [])].sort()
  expect(flags.length).toBeGreaterThan(0)
  for (const flag of flags) {
    expect(humans, flag).toContain(flag)
  }
})

test('docs/configuration.md names every closed config key', () => {
  const doc = readFileSync(join(ROOT, 'docs/configuration.md'), 'utf8')
  for (const { keys } of Object.values(SCHEMA_TABLES)) {
    for (const key of keys) {
      if (TABLE_KEYS.has(key)) {
        expect(doc, key).toContain(`[${key}]`)
        continue
      }
      expect(doc, key).toContain(`\`${key}\``)
    }
  }
})

test('docs/http-api.md names every door path the router serves', () => {
  const doc = readFileSync(join(ROOT, 'docs/http-api.md'), 'utf8')
  for (const path of DOOR_PATHS) {
    expect(doc, path).toContain(path)
  }
})
