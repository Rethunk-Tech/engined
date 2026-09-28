import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { asArray, assertKnownKeys, TOP_KEYS } from './configParse.ts'
import { ParseError } from './errors/parse.ts'
import { isRecord } from './records.ts'

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
function fragmentFiles(mainFile: string): string[] {
  const dir = join(dirname(mainFile), 'config.d')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw new ParseError('cannot read config.d', dir, { cause: err })
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
    throw new ParseError('cannot read config', file, { cause: err })
  }

  let raw: unknown
  try {
    raw = Bun.TOML.parse(text)
  } catch (err) {
    throw new ParseError('invalid TOML', file, { cause: err })
  }
  if (!isRecord(raw)) {
    throw new ParseError('config must be a table', file)
  }
  return raw
}

/** One `[[table]]` array plus which file each of its parsed entries came from -- what a collision or a cross-entry check needs to name the right fragment. */
interface Collected<T> {
  items: T[]
  files: string[]
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
  for (const { file, raw } of sources) {
    for (const [i, value] of asArray(raw[key], key, file).entries()) {
      items.push(parseOne(value, i, file))
      files.push(file)
    }
  }
  return { items, files }
}

/** Maps each collected entry's key to the file it came from, falling back to the main file. */
export function fileLookup<T, K>(
  items: readonly T[],
  files: readonly string[],
  keyOf: (item: T) => K,
  fallback: string,
): (key: K) => string {
  const fileOf = new Map<K, string>(items.map((item, i) => [keyOf(item), files[i] as string]))
  return (key) => fileOf.get(key) ?? fallback
}
