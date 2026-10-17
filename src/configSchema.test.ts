import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { renderConfigSchema, SCHEMA_TABLES } from './configSchema.ts'

test('every config key has a schema field with a description, and no field names an absent key', () => {
  for (const [name, { keys, fields }] of Object.entries(SCHEMA_TABLES)) {
    expect([name, Object.keys(fields).sort()]).toEqual([name, [...keys].sort()])
    for (const [key, field] of Object.entries(fields)) {
      expect([name, key, field.description.length > 0]).toEqual([name, key, true])
    }
  }
})

test('config.schema.json is the generated schema; run `bun run schema` after a key change', async () => {
  const committed = await Bun.file(join(import.meta.dir, '..', 'config.schema.json')).text()
  expect(committed).toBe(renderConfigSchema())
})
