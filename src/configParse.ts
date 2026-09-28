/**
 * The primitives every table's parser is written against: the shapes a TOML
 * value must have, the key sets each table admits, and the refusal a wrong one
 * earns. Fatal at parse, because a daemon serving a config it cannot fully
 * trust is worse than one that refuses to start.
 */

import { join } from 'node:path'
import { ParseError } from './errors/parse.ts'
import { dataHome, expandTilde } from './paths.ts'
import { isRecord } from './records.ts'
import type { ModelCapabilities, Role, VisionKind } from './types.ts'

export const ROLES: readonly Role[] = ['chat', 'vision', 'embedding', 'rerank']
export const VISION_KINDS: readonly VisionKind[] = ['describe', 'read']

/**
 * `~/.local/share/` in a config path means "wherever engined's own data
 * lives" -- the same base `dataHome()` gives `installDir()` -- not literally
 * the caller's home directory. Routing that one prefix through `dataHome()`
 * is what keeps a configured `models_dir` a sibling of `installDir()` even
 * when `XDG_DATA_HOME` overrides where both live; a bare `expandTilde` never
 * consults it and drifts to `$HOME/.local/share` regardless. Any other tilde
 * path is a literal home-directory reference and expands as one.
 */
const XDG_DATA_TILDE_PREFIX = '~/.local/share/'
export function expandConfigPath(p: string): string {
  return p.startsWith(XDG_DATA_TILDE_PREFIX)
    ? join(dataHome(), p.slice(XDG_DATA_TILDE_PREFIX.length))
    : expandTilde(p)
}

/** Closed sets: a typo'd key would otherwise silently do nothing. */
export const ENGINE_KEYS = new Set([
  'id',
  'disable',
  'spec_dir',
  'models_dir',
  'models_max',
  'idle_stop_seconds',
  'drain_timeout_seconds',
  'ready_timeout_s',
  'agent_version',
  'kind',
  'args',
])
export const UPSTREAM_KEYS = new Set([
  'id',
  'base_url',
  'secret',
  'egress',
  'wire',
  'disable',
  'inventory_max_age_seconds',
  'inventory_refresh_seconds',
  'headers',
])
/** Re-fetch interval when an upstream omits `inventory_refresh_seconds`. */
export const DEFAULT_INVENTORY_REFRESH_SECONDS = 3600
export const SECRET_KEYS = new Set(['service', 'username', 'header', 'scheme'])
export const MODEL_KEYS = new Set([
  'id',
  'input',
  'output',
  'context_in',
  'context_out',
  'reasoning',
])
export const ROUTE_KEYS = new Set([
  'engine',
  'model',
  'wire_model',
  'display_name',
  'upstream',
  'filename',
  'role',
  'vision',
  'translate',
  'fim',
  'keep_resident',
  'streaming',
  'slot_long_threshold',
  'vision_bridge',
  'args',
  'disable',
  'input',
  'output',
  'context_in',
  'context_out',
  'reasoning',
])
export const CHAIN_KEYS = new Set(['id', 'hops', 'disable'])
/** Root of `config.toml`. A typo here is the same class of silent miss as a table typo. */
export const TOP_KEYS = new Set([
  'listen_port',
  'cursor_port',
  'chat_timeout_seconds',
  'agent_timeout_seconds',
  'stream_stall_seconds',
  'agentic_concurrency',
  'engine',
  'upstream',
  'model',
  'route',
  'chain',
])

/** `setTimeout` takes a signed 32-bit millisecond count; seconds above this clamp to 1 ms. */
const MAX_SETTIMEOUT_SECONDS = 2_147_483

/** Absent is empty; present-but-not-an-array is a fatal shape error, never a silent zero entries. */
export function asArray(v: unknown, key: string, file: string): unknown[] {
  if (v === undefined) {
    return []
  }
  if (!Array.isArray(v)) {
    throw new ParseError(`"${key}" must be an array of tables`, file)
  }
  return v
}

export function requireString(v: unknown, label: string, file: string): string {
  if (typeof v !== 'string' || v === '') {
    throw new ParseError(`${label} is missing or empty`, file)
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
    throw new ParseError(`${label} must be a ${kind}`, file)
  }
  return v as T extends 'string' ? string : T extends 'number' ? number : boolean
}

/** Absent stays absent; a present number must be greater than 0. Zero has no documented meaning for any field this helper admits. */
export function optionalPositive(v: unknown, label: string, file: string): number | undefined {
  const n = optional(v, 'number', label, file)
  if (n !== undefined && n <= 0) {
    throw new ParseError(`${label} must be greater than 0`, file)
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
      file,
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
    throw new ParseError(`${label} must be an integer between 1 and ${PORT_MAX}`, file)
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
    throw new ParseError(`${label} must be a positive integer`, file)
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
    throw new ParseError(`${site} "args" must be a table`, file)
  }
  for (const [key, value] of Object.entries(v)) {
    const kind = typeof value
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      throw new ParseError(`${site} "args" key "${key}" must be a string, number or boolean`, file)
    }
    // Each arg is one `key = value` line of the llama preset INI.
    if (/[\r\n]/.test(`${key}${String(value)}`)) {
      throw new ParseError(`${site} "args" key ${JSON.stringify(key)} contains a line break`, file)
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
      throw new ParseError(`${site} has unrecognised key "${key}"`, file)
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
    throw new ParseError(`${site} must be a table`, file)
  }
  assertKnownKeys(raw, site, keys, file)
  return raw
}

const CAPABILITY_FIELDS = ['input', 'output', 'context_in', 'context_out', 'reasoning'] as const

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

/** Later layers win field by field: the `[[model]]` row, then what the role implies, then the route's own declaration. */
export function mergeCapabilities(...layers: readonly ModelCapabilities[]): ModelCapabilities {
  const merged: ModelCapabilities = {}
  for (const key of CAPABILITY_FIELDS) {
    for (const layer of layers) {
      const v = layer[key]
      if (v !== undefined) {
        ;(merged as Record<string, unknown>)[key] = v
      }
    }
  }
  return merged
}
