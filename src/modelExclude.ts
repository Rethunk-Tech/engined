/**
 * `exclude_models` matching, shared by the server (inventory read) and the config UI map.
 * An entry is a glob (`*` any run incl. `/`, `?` one char, rest literal, whole-id match),
 * or a JavaScript RegExp when wrapped in slashes (`u` flag, unanchored).
 */

export type ModelMatcher = (id: string) => boolean

const REGEX_ENTRY_RE = /^\/(.+)\/$/s
const GLOB_SPECIAL_RE = /[.+^${}()|[\]\\]/g

/** The compiled matcher, or an error message naming what is wrong with the entry. */
export function compileExclude(entry: string): ModelMatcher | { error: string } {
  if (entry === '') {
    return { error: 'is empty' }
  }
  const asRegex = REGEX_ENTRY_RE.exec(entry)
  if (asRegex?.[1] !== undefined) {
    try {
      const re = new RegExp(asRegex[1], 'u')
      return (id) => re.test(id)
    } catch (err) {
      return { error: `is not a valid regex: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const source = entry
    .replace(GLOB_SPECIAL_RE, '\\$&')
    .replace(/\*/g, '[\\s\\S]*')
    .replace(/\?/g, '[\\s\\S]')
  const re = new RegExp(`^${source}$`, 'u')
  return (id) => re.test(id)
}

/** A matcher for a list; entries that fail to compile match nothing (config load rejects them first). */
export function excludeMatcher(entries: readonly string[] | undefined): ModelMatcher {
  const compiled = (entries ?? []).flatMap((e) => {
    const m = compileExclude(e)
    return typeof m === 'function' ? [m] : []
  })
  return (id) => compiled.some((m) => m(id))
}
