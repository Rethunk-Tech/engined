/** Copying an entry out as TOML, and reading a pasted `[[table]]` snippet back into entries. */
import { parse, stringify } from '@decimalturn/toml-patch'
import { isTable, type Table } from './model.ts'

export function entryToToml(table: string, entry: Table): string {
  return stringify({ [table]: [entry] })
}

/** The entries of `table` a snippet declares, or the reason it is not one. */
export function snippetEntries(
  text: string,
  table: string,
): { entries: Table[] } | { error: string } {
  let raw: Table
  try {
    raw = parse(text) as Table
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const other = Object.keys(raw).filter((k) => k !== table)
  if (other.length > 0) {
    return {
      error: `the snippet has "${other.join('", "')}", but this list takes [[${table}]] entries only`,
    }
  }
  const entries = Array.isArray(raw[table]) ? raw[table].filter(isTable) : []
  return entries.length === 0 ? { error: `no [[${table}]] entry found` } : { entries }
}
