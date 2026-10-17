/** Field help and types from config.schema.json, served by GET /api/schema. */
import { signal } from '@preact/signals'
import { call } from './api.ts'

export interface Prop {
  description?: string
  type?: string | string[]
  enum?: string[]
  items?: { type?: string }
}

interface Schema {
  properties?: Record<string, Prop>
  $defs?: Record<string, { properties?: Record<string, Prop> }>
}

const schema = signal<Schema | undefined>()

export async function loadSchema(): Promise<void> {
  if (schema.value === undefined) {
    schema.value = await call<Schema>('/api/schema').catch(() => undefined)
  }
}

/** `table` is a `$defs` name (`engine`, `route`, ...) or `top` for the root keys. */
export function propOf(table: string, key: string): Prop {
  const source =
    table === 'top' ? schema.value?.properties : schema.value?.$defs?.[table]?.properties
  return source?.[key] ?? {}
}
