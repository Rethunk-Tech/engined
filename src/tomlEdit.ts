/**
 * Structured edits to `config.toml` text that keep every comment and the
 * layout around what changed. Each edit parses with toml-patch, mutates the
 * object, and patches the text back; then Bun's own parser must read the
 * result as exactly the mutated object, or the edit throws. A wrong file is
 * never returned.
 */
import { parse, patch } from '@decimalturn/toml-patch'
import { ID_RE } from './config.ts'
import { isRecord } from './records.ts'
import { qualifiedSegments } from './routeAddress.ts'

/** Top-level keys, then a table key, or a `[[table]]` entry's index and key; `args` tables nest one deeper. */
export type TomlPath = (string | number)[]

export type EditOp =
  | { op: 'setKey'; path: TomlPath; value: unknown }
  | { op: 'addEntry'; table: string; entry: Record<string, unknown> }
  | { op: 'removeEntry'; table: string; index: number }
  | { op: 'renameId'; table: string; oldId: string; newId: string }

type Doc = Record<string, unknown>

/** Tables whose entries carry an `id` other entries can point at. */
const ID_TABLES = ['engine', 'upstream', 'model', 'chain'] as const

function entriesOf(doc: Doc, table: string): Doc[] {
  const entries = doc[table]
  return Array.isArray(entries) ? entries.filter(isRecord) : []
}

function applyOne(doc: Doc, op: EditOp): void {
  switch (op.op) {
    case 'setKey':
      setAt(doc, op.path, op.value)
      return
    case 'addEntry': {
      const entries = doc[op.table] ?? []
      if (!Array.isArray(entries)) {
        throw new Error(`"${op.table}" is not an array of tables`)
      }
      entries.push(structuredClone(op.entry))
      doc[op.table] = entries
      return
    }
    case 'removeEntry': {
      const entries = doc[op.table]
      if (!Array.isArray(entries) || entries[op.index] === undefined) {
        throw new Error(`${op.table}[${op.index}] does not exist`)
      }
      entries.splice(op.index, 1)
      if (entries.length === 0) {
        delete doc[op.table]
      }
      return
    }
    case 'renameId':
      renameId(doc, op.table, op.oldId, op.newId)
  }
}

/** One step down a path; a missing table key is created (an `args` table), a missing array slot is not. */
function descend(node: unknown, step: string | number): object | undefined {
  let next: unknown
  if (Array.isArray(node) && typeof step === 'number') {
    next = node[step]
  } else if (isRecord(node) && typeof step === 'string') {
    next = node[step]
    if (next === undefined) {
      next = {}
      node[step] = next
    }
  }
  return typeof next === 'object' && next !== null ? next : undefined
}

function setAt(doc: Doc, path: TomlPath, value: unknown): void {
  const last = path.at(-1)
  if (last === undefined) {
    throw new Error('empty path')
  }
  let node: unknown = doc
  for (const step of path.slice(0, -1)) {
    node = descend(node, step)
    if (node === undefined) {
      throw new Error(`nothing at ${path.join('.')}`)
    }
  }
  if (Array.isArray(node) && typeof last === 'number') {
    node[last] = structuredClone(value)
    return
  }
  if (!isRecord(node) || typeof last !== 'string') {
    throw new Error(`${path.join('.')} does not address a key`)
  }
  if (value === undefined) {
    delete node[last]
  } else {
    node[last] = structuredClone(value)
  }
}

/** Runs `ops` in order against `src`; any op, or a result Bun reads differently, throws. */
export function applyOps(src: string, ops: readonly EditOp[]): string {
  const patched = parse(src) as Doc
  const expected = Bun.TOML.parse(src) as Doc
  for (const op of ops) {
    applyOne(patched, op)
    applyOne(expected, op)
  }
  const out = patch(src, patched)
  if (!Bun.deepEquals(Bun.TOML.parse(out), expected, true)) {
    throw new Error('the edit would not round-trip; nothing was changed')
  }
  return out
}

export const setKey = (src: string, path: TomlPath, value: unknown): string =>
  applyOps(src, [{ op: 'setKey', path, value }])
export const addEntry = (src: string, table: string, entry: Record<string, unknown>): string =>
  applyOps(src, [{ op: 'addEntry', table, entry }])
export const removeEntry = (src: string, table: string, index: number): string =>
  applyOps(src, [{ op: 'removeEntry', table, index }])
export const renameIdIn = (src: string, table: string, oldId: string, newId: string): string =>
  applyOps(src, [{ op: 'renameId', table, oldId, newId }])

/** One place a value names an id: where it sits and how it reads after a rename. */
interface Reference {
  path: TomlPath
  value: string
  rewrite: (newId: string) => string
}

/** Which segment of the address (0-based) names `id` of `table`, or -1. */
function idPosition(
  segments: readonly string[],
  table: string,
  id: string,
  routes: readonly Doc[],
): number {
  const [engine, second, third] = segments
  if (table === 'engine') {
    return segments.length > 1 && engine === id ? 0 : -1
  }
  // A modelless engine's two-segment address names an upstream, not a model.
  const engineRoutes = routes.filter((r) => r.engine === engine)
  const modelless = engineRoutes.length > 0 && engineRoutes.every((r) => r.model === undefined)
  if (table === 'upstream') {
    return second === id && (third !== undefined || modelless) ? 1 : -1
  }
  if (table === 'model' && routes.some((r) => r.engine === engine && r.model === id)) {
    if (third !== undefined) {
      return third === id ? 2 : -1
    }
    return second === id && !modelless ? 1 : -1
  }
  return -1
}

function addressReference(
  address: string,
  table: string,
  id: string,
  routes: readonly Doc[],
): ((newId: string) => string) | undefined {
  const segments = qualifiedSegments(address)
  if (segments === undefined) {
    return undefined
  }
  const position = idPosition(segments, table, id, routes)
  if (position < 0) {
    return undefined
  }
  return (newId) => `@/${segments.map((seg, i) => (i === position ? newId : seg)).join('/')}`
}

function referencesTo(doc: Doc, table: string, id: string): Reference[] {
  const routes = entriesOf(doc, 'route')
  const refs: Reference[] = []
  const direct = (path: TomlPath, value: unknown): void => {
    if (value === id) {
      refs.push({ path, value: id, rewrite: (newId) => newId })
    }
  }
  const address = (path: TomlPath, value: unknown): void => {
    if (typeof value !== 'string') {
      return
    }
    const rewrite = addressReference(value, table, id, routes)
    if (rewrite !== undefined) {
      refs.push({ path, value, rewrite })
    }
  }
  for (const [i, route] of routes.entries()) {
    if (table === 'engine') {
      direct(['route', i, 'engine'], route.engine)
    } else if (table === 'upstream') {
      direct(['route', i, 'upstream'], route.upstream)
    } else if (table === 'model') {
      direct(['route', i, 'model'], route.model)
    }
    address(['route', i, 'vision_bridge'], route.vision_bridge)
    address(['route', i, 'wire_model'], route.wire_model)
  }
  if (table === 'model') {
    for (const [i, engine] of entriesOf(doc, 'engine').entries()) {
      const served = routes.some((r) => r.engine === engine.id && r.model === id)
      if (served) {
        direct(['engine', i, 'default_model'], engine.default_model)
      }
    }
  }
  for (const [i, chain] of entriesOf(doc, 'chain').entries()) {
    for (const [h, hop] of (Array.isArray(chain.hops) ? chain.hops : []).entries()) {
      address(['chain', i, 'hops', h], hop)
    }
  }
  return refs
}

/** Every value that names `id` of `table`, as `route[2].engine`-style locations, for a delete guard. */
export function dependents(src: string, table: string, id: string): string[] {
  return referencesTo(Bun.TOML.parse(src) as Doc, table, id).map((ref) =>
    ref.path.reduce<string>(
      (acc, step) =>
        typeof step === 'number' ? `${acc}[${step}]` : `${acc}${acc === '' ? '' : '.'}${step}`,
      '',
    ),
  )
}

function renameId(doc: Doc, table: string, oldId: string, newId: string): void {
  if (!(ID_TABLES as readonly string[]).includes(table)) {
    throw new Error(`"${table}" entries have no id to rename`)
  }
  const entries = entriesOf(doc, table)
  const entry = entries.find((e) => e.id === oldId)
  if (entry === undefined) {
    throw new Error(`no ${table} "${oldId}"`)
  }
  if (newId === '' || ((table === 'engine' || table === 'upstream') && !ID_RE.test(newId))) {
    throw new Error(`"${newId}" is not a valid ${table} id`)
  }
  if (newId !== oldId && entries.some((e) => e.id === newId)) {
    throw new Error(`${table} "${newId}" already exists`)
  }
  if (table === 'engine' && entry.kind === undefined && entry.spec_dir === undefined) {
    throw new Error(
      `engine "${oldId}" takes its spec from engines/${oldId}/spec.toml, so its id names a directory; set "spec_dir" or "kind" first, or the renamed engine has no spec`,
    )
  }
  // References are computed before the id changes: a model reference is only one if a route still names the old id.
  for (const ref of referencesTo(doc, table, oldId)) {
    setAt(doc, ref.path, ref.rewrite(newId))
  }
  entry.id = newId
}
