/** Checks and suggestions for `[engine.args]` / `[route.args]` entries as they are typed. */

import { argKeysAsFlags, assertNoForbiddenFlags } from '../../agenticArgs.ts'
import { argProblem } from '../../argRules.ts'
import type { EngineKind } from '../../types.ts'
import { isTable, type Table } from './model.ts'

/** The parser's reason an entry is refused, or undefined. Route args are flag-checked for every kind; engine args only on an agentic engine, whose argv is the agent's. */
export function argIssue(
  key: string,
  value: unknown,
  scope: { site: 'route' | 'engine'; kind: EngineKind | undefined },
): string | undefined {
  const shape = argProblem(key, value)
  if (shape !== undefined) {
    return shape
  }
  if (scope.site === 'route' || scope.kind === 'agentic-cli') {
    try {
      assertNoForbiddenFlags(argKeysAsFlags({ [key]: value }), '')
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  return undefined
}

/** Read a typed value the way TOML would: booleans and numbers keep their type, anything else is a string. */
export function argValueFromText(text: string): string | number | boolean {
  if (text === 'true' || text === 'false') {
    return text === 'true'
  }
  const n = Number(text)
  return text.trim() !== '' && Number.isFinite(n) ? n : text
}

function argKeysIn(args: unknown): string[] {
  return isTable(args) ? Object.keys(args) : []
}

/** Keys the spec's own `[args]` defaults and the shipped example config use, minus those already set, most used first. */
export function suggestArgKeys(
  spec: Table | undefined,
  example: Table | undefined,
  have: readonly string[],
): string[] {
  const count = new Map<string, number>()
  const note = (key: string) => count.set(key, (count.get(key) ?? 0) + 1)
  for (const key of argKeysIn(spec?.args)) {
    note(key)
  }
  for (const group of ['engine', 'route']) {
    const entries = example?.[group]
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const key of argKeysIn(isTable(entry) ? entry.args : undefined)) {
        note(key)
      }
    }
  }
  return [...count.entries()]
    .filter(([key]) => !have.includes(key))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key)
}
