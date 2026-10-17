/**
 * The primitives every table's parser is written against: the shapes a TOML
 * value must have, the key sets each table admits, and the refusal a wrong one
 * earns. Fatal at parse, because a daemon serving a config it cannot fully
 * trust is worse than one that refuses to start.
 */

import { join } from 'node:path'
import { argProblem } from './argRules.ts'
import { ParseError } from './errors/parse.ts'
import { dataHome, expandTilde } from './paths.ts'
import { isRecord } from './records.ts'
import type { ModelCapabilities } from './types.ts'

/**
 * `~/.local/share/` in a config path means "wherever engined's own data
 * lives" -- `dataHome()`, the base an `install.sh` install sits under -- not
 * literally the caller's home directory. Routing that one prefix through
 * `dataHome()` is what keeps a configured `models_dir` under the data home even
 * when `XDG_DATA_HOME` overrides where it lives; a bare `expandTilde` never
 * consults it and drifts to `$HOME/.local/share` regardless. Any other tilde
 * path is a literal home-directory reference and expands as one.
 */
const XDG_DATA_TILDE_PREFIX = '~/.local/share/'
export function expandConfigPath(p: string): string {
  return p.startsWith(XDG_DATA_TILDE_PREFIX)
    ? join(dataHome(), p.slice(XDG_DATA_TILDE_PREFIX.length))
    : expandTilde(p)
}

/** `setTimeout` takes a signed 32-bit millisecond count; seconds above this clamp to 1 ms. */
const MAX_SETTIMEOUT_SECONDS = 2_147_483

/** The key a diagnostic label ends in, for example `route[0] "role"` or `config "configsvc.port"`; absent when the label names only an entry. */
function labelKey(label: string): string | undefined {
  return /"([^"]+)"$/.exec(label)?.[1]
}

/** Absent is empty; present-but-not-an-array is a fatal shape error, never a silent zero entries. */
export function asArray(v: unknown, key: string, file: string): unknown[] {
  if (v === undefined) {
    return []
  }
  if (!Array.isArray(v)) {
    throw new ParseError(`"${key}" must be an array of tables`, { file, key })
  }
  return v
}

export function requireString(v: unknown, label: string, file: string): string {
  if (typeof v !== 'string' || v === '') {
    throw new ParseError(`${label} is missing or empty`, { file, key: labelKey(label) })
  }
  return v
}

/** One helper for both optional-typed keys; `kind` selects "string" or "number". */
export function optional<T extends 'string' | 'number' | 'boolean'>(
  v: unknown,
  kind: T,
  label: string,
  file: string,
): (T extends 'string' ? string : T extends 'number' ? number : boolean) | undefined {
  if (v === undefined) {
    return
  }
  if (typeof v !== kind) {
    throw new ParseError(`${label} must be a ${kind}`, { file, key: labelKey(label) })
  }
  return v as T extends 'string' ? string : T extends 'number' ? number : boolean
}

/** Absent stays absent; a present number must be greater than 0. Zero has no documented meaning for any field this helper admits. */
export function optionalPositive(v: unknown, label: string, file: string): number | undefined {
  const n = optional(v, 'number', label, file)
  if (n !== undefined && n <= 0) {
    throw new ParseError(`${label} must be greater than 0`, { file, key: labelKey(label) })
  }
  return n
}

/**
 * A duration that will be multiplied by 1000 and handed to `setTimeout`.
 * Values above `MAX_SETTIMEOUT_SECONDS` overflow that API and become 1 ms.
 */
export function optionalTimeoutSeconds(
  v: unknown,
  label: string,
  file: string,
): number | undefined {
  const n = optionalPositive(v, label, file)
  if (n !== undefined && n > MAX_SETTIMEOUT_SECONDS) {
    throw new ParseError(
      `${label} exceeds the setTimeout ceiling of ${MAX_SETTIMEOUT_SECONDS} seconds`,
      { file, key: labelKey(label) },
    )
  }
  return n
}

const PORT_MAX = 65_535

/** A TCP port: integer 1–65535. Absent uses `fallback`. */
export function parsePort(v: unknown, label: string, file: string, fallback: number): number {
  if (v === undefined) {
    return fallback
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > PORT_MAX) {
    throw new ParseError(`${label} must be an integer between 1 and ${PORT_MAX}`, {
      file,
      key: labelKey(label),
    })
  }
  return v
}

/** Absent uses `fallback`. Present must be a positive integer. */
export function parsePositiveInteger(
  v: unknown,
  label: string,
  file: string,
  fallback: number,
): number {
  if (v === undefined) {
    return fallback
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ParseError(`${label} must be a positive integer`, { file, key: labelKey(label) })
  }
  return v
}

/** `disable = true` is the only value that ever sets the derived flag; absent or `false` both mean "not disabled", so the flag is never explicitly `false`. */
export function parseDisable(
  raw: Record<string, unknown>,
  label: string,
  file: string,
): boolean | undefined {
  return optional(raw.disable, 'boolean', `${label} "disable"`, file) === true ? true : undefined
}

/**
 * Values must be scalar because every consumer renders them with `String(v)` --
 * `argvFromArgs` onto a command line, `iniLines` into the llama preset. A
 * nested table parses as valid TOML and would reach the engine as the literal
 * "[object Object]", so it is refused here rather than shipped silently.
 */

export function asArgs(v: unknown, site: string, file: string): Record<string, unknown> {
  if (v === undefined) {
    return {}
  }
  if (!isRecord(v)) {
    throw new ParseError(`${site} "args" must be a table`, { file, key: 'args' })
  }
  for (const [key, value] of Object.entries(v)) {
    const problem = argProblem(key, value)
    if (problem !== undefined) {
      throw new ParseError(`${site} "args" ${problem}`, { file, key: 'args' })
    }
  }
  return v
}

/**
 * Every closed table is checked the same way, config and spec alike: a key
 * engined does not read is a typo, and dropping it silently defers the failure
 * to whatever the missing value was load-bearing for -- a misspelt
 * `images_workflow` surfaces as the door refusing an image request against an
 * engine that looks configured for one.
 */
export function assertKnownKeys(
  raw: Record<string, unknown>,
  site: string,
  keys: ReadonlySet<string>,
  file: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!keys.has(key)) {
      throw new ParseError(`${site} has unrecognised key "${key}"`, { file, key })
    }
  }
}

/** Every `[[table]]` entry is checked the same way before any of its fields are read: it must be a table, and an unrecognised key is a typo the operator wants named rather than silently ignored. */
export function requireTable(
  raw: unknown,
  site: string,
  keys: ReadonlySet<string>,
  file: string,
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new ParseError(`${site} must be a table`, { file, key: labelKey(site) })
  }
  assertKnownKeys(raw, site, keys, file)
  return raw
}

export function parseCapabilities(
  raw: Record<string, unknown>,
  site: string,
  file: string,
): ModelCapabilities {
  const stringArray = (key: string): string[] | undefined =>
    raw[key] === undefined
      ? undefined
      : asArray(raw[key], `${site} "${key}"`, file).map((v, i) =>
          requireString(v, `${site} "${key}[${i}]"`, file),
        )
  return {
    input: stringArray('input'),
    output: stringArray('output'),
    context_in: optionalPositive(raw.context_in, `${site} "context_in"`, file),
    context_out: optionalPositive(raw.context_out, `${site} "context_out"`, file),
    reasoning: stringArray('reasoning'),
  }
}
