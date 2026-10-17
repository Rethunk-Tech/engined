import type { ConfigPath } from './errors/parse.ts'

/**
 * Where each parsed engine, upstream, route and chain came from. Held beside
 * the config rather than on it, so the entries stay the shapes the door
 * serves and tests build, while a check that runs after parsing (cross-route
 * validation, spec-time kind checks) can still name the entry it refuses.
 */
const ORIGINS = new WeakMap<object, ConfigPath>()

export function recordOrigins(
  items: readonly object[],
  table: string,
  files: readonly string[],
  indexes: readonly number[],
): void {
  for (const [i, item] of items.entries()) {
    ORIGINS.set(item, { file: files[i] as string, table, index: indexes[i] as number })
  }
}

export function originOf(item: object, key?: string): ConfigPath | undefined {
  const origin = ORIGINS.get(item)
  return origin === undefined || key === undefined ? origin : { ...origin, key }
}
