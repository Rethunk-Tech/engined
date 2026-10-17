/** The config files on disk for the config UI: reading, the line diff, history and the atomic save. */
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { configFilesSha256, fragmentFiles } from './configSources.ts'
import {
  type Checked,
  checkConfigText,
  enginesToRestart,
  type ValidateEnv,
} from './configsvcValidate.ts'
import { isRecord } from './records.ts'

const HISTORY_KEEP = 20
const HISTORY_NAME_RE = /^config-\d{8}T\d{6}Z(?:-\d+)?\.toml$/

export interface ConfigSnapshot {
  path: string
  text: string
  /** Over `config.toml` and `config.d/`, the same hash engined reports as `config_sha256`. */
  sha256: string
  fragments: { file: string; text: string }[]
}

export function readSnapshot(configFile: string): ConfigSnapshot {
  const text = existsSync(configFile) ? readFileSync(configFile, 'utf8') : ''
  let fragments: { file: string; text: string }[] = []
  try {
    fragments = fragmentFiles(configFile).map((file) => ({
      file,
      text: readFileSync(file, 'utf8'),
    }))
  } catch {
    // An unreadable config.d is reported by validation, not by reading.
  }
  return { path: configFile, text, sha256: configFilesSha256(configFile) ?? '', fragments }
}

/** A unified line diff (3 lines of context) of `before` to `after`; empty when they are equal. */
export function unifiedDiff(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++
  }
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) {
    tail++
  }
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  if (x.length === 0 && y.length === 0) {
    return ''
  }
  // Longest common subsequence of the differing middle, as a table of suffix lengths.
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      const row = lcs[i] as Uint32Array
      row[j] =
        x[i] === y[j]
          ? ((lcs[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as Uint32Array)[j] as number, row[j + 1] as number)
    }
  }
  const ops: { tag: ' ' | '-' | '+'; line: string }[] = a
    .slice(0, head)
    .map((line) => ({ tag: ' ' as const, line }))
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      ops.push({ tag: ' ', line: x[i] as string })
      i++
      j++
    } else if (
      j < y.length &&
      (i === x.length ||
        ((lcs[i] as Uint32Array)[j + 1] as number) >= ((lcs[i + 1] as Uint32Array)[j] as number))
    ) {
      ops.push({ tag: '+', line: y[j] as string })
      j++
    } else {
      ops.push({ tag: '-', line: x[i] as string })
      i++
    }
  }
  for (const line of a.slice(a.length - tail)) {
    ops.push({ tag: ' ', line })
  }
  return hunks(ops)
}

const CONTEXT = 3

function hunks(ops: { tag: ' ' | '-' | '+'; line: string }[]): string {
  const keep = new Set<number>()
  for (const [i, op] of ops.entries()) {
    if (op.tag !== ' ') {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) {
        keep.add(k)
      }
    }
  }
  const out: string[] = []
  let oldLine = 1
  let newLine = 1
  let i = 0
  while (i < ops.length) {
    if (!keep.has(i)) {
      oldLine += ops[i]?.tag === '+' ? 0 : 1
      newLine += ops[i]?.tag === '-' ? 0 : 1
      i++
      continue
    }
    const startOld = oldLine
    const startNew = newLine
    let removed = 0
    let added = 0
    const body: string[] = []
    for (; i < ops.length && keep.has(i); i++) {
      const op = ops[i] as { tag: ' ' | '-' | '+'; line: string }
      body.push(`${op.tag}${op.line}`)
      removed += op.tag === '+' ? 0 : 1
      added += op.tag === '-' ? 0 : 1
    }
    oldLine += removed
    newLine += added
    out.push(`@@ -${startOld},${removed} +${startNew},${added} @@`, ...body)
  }
  return `${out.join('\n')}\n`
}

function historyDir(configFile: string): string {
  return join(dirname(configFile), '.history')
}

export function listHistory(
  configFile: string,
): { name: string; bytes: number; modified: string }[] {
  try {
    return readdirSync(historyDir(configFile))
      .filter((name) => HISTORY_NAME_RE.test(name))
      .sort()
      .reverse()
      .map((name) => {
        const stat = statSync(join(historyDir(configFile), name))
        return { name, bytes: stat.size, modified: stat.mtime.toISOString() }
      })
  } catch {
    return []
  }
}

export function readHistory(configFile: string, name: string): string | undefined {
  return HISTORY_NAME_RE.test(name)
    ? readFileSync(join(historyDir(configFile), name), 'utf8')
    : undefined
}

function keepHistory(configFile: string, now: Date): void {
  const dir = historyDir(configFile)
  mkdirSync(dir, { recursive: true })
  const stamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+/, '')
  let name = `config-${stamp}.toml`
  for (let n = 1; existsSync(join(dir, name)); n++) {
    name = `config-${stamp}-${n}.toml`
  }
  copyFileSync(configFile, join(dir, name))
  for (const old of listHistory(configFile).slice(HISTORY_KEEP)) {
    rmSync(join(dir, old.name), { force: true })
  }
}

/** Which entries differ, as `table:id` (routes, which have none, as `route:engine/model-or-upstream`) and top-level keys. */
function changedEntries(beforeText: string, afterText: string): string[] {
  const parse = (text: string): Record<string, unknown> => {
    try {
      return Bun.TOML.parse(text) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const before = parse(beforeText)
  const after = parse(afterText)
  const label = (table: string, entry: unknown): string => {
    const e = isRecord(entry) ? entry : {}
    return table === 'route'
      ? `route:${String(e.engine)}/${String(e.model ?? e.upstream ?? '')}`
      : `${table}:${String(e.id)}`
  }
  const changed = new Set<string>()
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = before[key]
    const right = after[key]
    if (Bun.deepEquals(left, right, true)) {
      continue
    }
    if (!(Array.isArray(left) || Array.isArray(right))) {
      changed.add(`top:${key}`)
      continue
    }
    const mine = new Map(
      (Array.isArray(left) ? left : []).map((e) => [JSON.stringify(e), label(key, e)]),
    )
    const theirs = new Map(
      (Array.isArray(right) ? right : []).map((e) => [JSON.stringify(e), label(key, e)]),
    )
    for (const [json, name] of [...mine, ...theirs]) {
      if (!(mine.has(json) && theirs.has(json))) {
        changed.add(name)
      }
    }
  }
  return [...changed].sort()
}

interface SaveResult {
  sha256: string
  restart: string[]
  hard_reload_needed: boolean
  changed: string[]
}

export type SaveOutcome =
  | { ok: true; result: SaveResult; before: string }
  | { ok: false; status: 409; current: ConfigSnapshot }
  | { ok: false; status: 422; checked: Checked }

/** Conflict check, validation, history copy, then temp file and rename over `config.toml`. */
export function saveConfig(
  env: ValidateEnv,
  text: string,
  baseSha256: string,
  now: Date = new Date(),
): SaveOutcome {
  const current = readSnapshot(env.configFile)
  if (current.sha256 !== baseSha256) {
    return { ok: false, status: 409, current }
  }
  const checked = checkConfigText(text, env)
  if (checked.config === undefined) {
    return { ok: false, status: 422, checked }
  }
  const previous = checkConfigText(current.text, env).config
  let restart: string[] = []
  try {
    restart = previous === undefined ? [] : enginesToRestart(previous, checked.config, env)
  } catch {
    // The old config no longer builds (a spec moved); there is nothing to compare against.
  }
  if (existsSync(env.configFile)) {
    keepHistory(env.configFile, now)
  }
  const temp = join(dirname(env.configFile), `.config.toml.tmp-${randomBytes(6).toString('hex')}`)
  mkdirSync(dirname(env.configFile), { recursive: true })
  writeFileSync(temp, text)
  renameSync(temp, env.configFile)
  return {
    ok: true,
    before: current.sha256,
    result: {
      sha256: readSnapshot(env.configFile).sha256,
      restart,
      hard_reload_needed:
        previous !== undefined &&
        (previous.listen_port !== checked.config.listen_port ||
          previous.cursor_port !== checked.config.cursor_port),
      changed: changedEntries(current.text, text),
    },
  }
}
