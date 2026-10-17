/** What one `[engine.args]` / `[route.args]` entry may be, shared by the parser and the config UI. */

const LINE_BREAK_RE = /[\r\n]/
const INI_KEY_BREAKER_RE = /^$|^\s|\s$|[=[\]]|^[;#]/

/**
 * Values must be scalar because every consumer renders them with `String(v)` --
 * `argvFromArgs` onto a command line, `iniLines` into the llama preset. A
 * nested table parses as valid TOML and would reach the engine as the literal
 * "[object Object]". Each arg is also one `key = value` line of the llama
 * preset INI, under a section whose own `model =` line the preset writes first.
 * The answer is a phrase beginning "key ...", or undefined when the entry is fine.
 */
export function argProblem(key: string, value: unknown): string | undefined {
  const kind = typeof value
  if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
    return `key "${key}" must be a string, number or boolean`
  }
  if (LINE_BREAK_RE.test(`${key}${String(value)}`)) {
    return `key ${JSON.stringify(key)} contains a line break`
  }
  if (INI_KEY_BREAKER_RE.test(key) || key === 'model') {
    return `key ${JSON.stringify(key)} is empty, "model", has leading or trailing whitespace, or contains "=", "[", "]", or a leading ";" or "#", which the llama preset INI cannot carry as a key`
  }
  return undefined
}
