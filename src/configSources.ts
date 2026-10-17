import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { asArray, assertKnownKeys, TOP_KEYS } from './configParse.ts'
import { ParseError } from './errors/parse.ts'
import { errMessage, isRecord } from './records.ts'

const BUN_TOML_PREFIX = /^TOML Parse error: /

/** Scalar keys that only the main config file may carry -- everything else in `TOP_KEYS` is one of the five arrays a fragment may also extend. */
const FRAGMENT_TABLE_KEYS = new Set(['engine', 'upstream', 'model', 'route', 'chain'])

/** A parsed source file plus the raw table it produced, in the order its entries merge. */
interface ConfigSource {
  file: string
  raw: Record<string, unknown>
}

/**
 * `config.d/*.toml` beside the main file, sorted by filename -- the same
 * order their `[[engine]]`/etc. arrays are appended in. A missing directory
 * is normal and silent, since most installs have no fragments at all.
 */
export function fragmentFiles(mainFile: string): string[] {
  const dir = join(dirname(mainFile), 'config.d')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw new ParseError(`${dir}: cannot read config.d`, { cause: err })
  }
  return (
    names
      // A dotfile is an editor's lock or swap file (Emacs `.#foo.toml` is a
      // dangling symlink), never a fragment someone meant to load.
      .filter((name) => name.endsWith('.toml') && !name.startsWith('.'))
      .sort()
      .map((name) => join(dir, name))
  )
}

/**
 * The main config plus every `config.d` fragment, each read and key-checked
 * on its own: the main file against the full `TOP_KEYS`, a fragment against
 * only the five array keys, since a fragment scalar like `listen_port` would
 * silently shadow or fight the main file's depending on merge order.
 */
export function readConfigSources(mainFile: string): ConfigSource[] {
  const mainRaw = readConfigTable(mainFile)
  assertKnownKeys(mainRaw, 'config', TOP_KEYS, mainFile)
  const sources: ConfigSource[] = [{ file: mainFile, raw: mainRaw }]
  for (const fragFile of fragmentFiles(mainFile)) {
    const fragRaw = readConfigTable(fragFile)
    assertKnownKeys(fragRaw, 'config.d fragment', FRAGMENT_TABLE_KEYS, fragFile)
    sources.push({ file: fragFile, raw: fragRaw })
  }
  return sources
}

/** The config file as a parsed TOML table; every read or parse failure is a ParseError naming the file. */
function readConfigTable(file: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new ParseError(`${file}: cannot read config`, { cause: err })
  }

  let raw: unknown
  try {
    raw = Bun.TOML.parse(text)
  } catch (err) {
    throw new ParseError(`${tomlLocation(file)}: invalid TOML: ${tomlReason(err)}`, { cause: err })
  }
  if (!isRecord(raw)) {
    throw new ParseError('config must be a table', file)
  }
  return raw
}

/**
 * `file:line:column` for a file Bun.TOML.parse rejected. That parser reports no
 * position, but Bun's TOML module loader runs the same parser and does. Only a
 * `.toml` path loads as TOML; anything else would report a JavaScript position.
 */
function tomlLocation(file: string): string {
  if (!file.endsWith('.toml')) {
    return file
  }
  try {
    import.meta.require(file)
  } catch (err) {
    const position = isRecord(err) ? err.position : undefined
    if (
      isRecord(position) &&
      typeof position.line === 'number' &&
      typeof position.column === 'number'
    ) {
      return `${file}:${position.line}:${position.column}`
    }
  } finally {
    // The file can be fixed between the read and this load, and a load that
    // succeeds is cached, which would leave every later failure unlocated.
    delete require.cache[file]
  }
  return file
}

/** Bun's own reason, without the prefix every one of its TOML errors repeats. */
function tomlReason(err: unknown): string {
  return errMessage(err).replace(BUN_TOML_PREFIX, '')
}

/** Runs `fn`, and names the `[[table]]` entry at `index` on a ParseError that did not already say which entry it is. */
export function inEntry<T>(table: string, index: number, fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof ParseError && err.path !== undefined && err.path.table === undefined) {
      err.path = { ...err.path, table, index }
    }
    throw err
  }
}

/** One `[[table]]` array plus which file each of its parsed entries came from -- what a collision or a cross-entry check needs to name the right fragment. */
interface Collected<T> {
  items: T[]
  files: string[]
  /** Parallel to `items`: each entry's position within its own file's array, which is what a diagnostic names. */
  indexes: number[]
}

/**
 * Parses one array key (`engine`, `upstream`, ...) out of every source in
 * order -- the main file first, then each `config.d` fragment in sorted
 * filename order -- so the merged result reads exactly as if all the arrays
 * had been declared in one file, while every parse error still names the
 * fragment it came from.
 */
export function collectEntries<T>(
  sources: readonly ConfigSource[],
  key: string,
  parseOne: (value: unknown, index: number, file: string) => T,
): Collected<T> {
  const items: T[] = []
  const files: string[] = []
  const indexes: number[] = []
  for (const { file, raw } of sources) {
    for (const [i, value] of asArray(raw[key], key, file).entries()) {
      items.push(inEntry(key, i, () => parseOne(value, i, file)))
      files.push(file)
      indexes.push(i)
    }
  }
  return { items, files, indexes }
}
