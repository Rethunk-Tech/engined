/** Where a validation problem sits in the text being edited, as character offsets. */
import type { Problem } from './store.ts'

const HEADER_RE = /^\s*\[\[?[^\]]+\]\]?\s*$/
const ARGS_HEADER_RE = /^\s*\[\w+\.args\]/
const WORD_RE = /^[\w.-]+|^./

export interface Span {
  from: number
  to: number
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1)
    }
  }
  return starts
}

/** The `[[table]]` header lines, in file order, with the index each one is. */
function entryLine(lines: string[], table: string, index: number): number {
  let seen = -1
  for (const [i, line] of lines.entries()) {
    if (line.trim() === `[[${table}]]` && ++seen === index) {
      return i
    }
  }
  return -1
}

/** The line a keyed problem names: the key inside its entry, else the entry header, else the key at the top level. */
function pathLine(lines: string[], path: NonNullable<Problem['path']>): number {
  const { table, index, key } = path
  const keyLine = (from: number, until: number): number => {
    for (let i = from; i < until; i++) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i] ?? '')) {
        return i
      }
    }
    return -1
  }
  if (table !== undefined && index !== undefined) {
    const header = entryLine(lines, table, index)
    if (header < 0) {
      return -1
    }
    let end = lines.length
    for (let i = header + 1; i < lines.length; i++) {
      if (HEADER_RE.test(lines[i] ?? '') && !ARGS_HEADER_RE.test(lines[i] ?? '')) {
        end = i
        break
      }
    }
    const found = key === undefined ? -1 : keyLine(header + 1, end)
    return found < 0 ? header : found
  }
  return key === undefined ? -1 : keyLine(0, lines.length)
}

/** The span to underline: from `line:column` to the end of that word, or the whole line when the position is unknown. */
export function locate(text: string, problem: Problem): Span {
  const starts = lineStarts(text)
  const lines = text.split('\n')
  let line = problem.line === undefined ? -1 : problem.line - 1
  if (line < 0 && problem.path !== undefined) {
    line = pathLine(lines, problem.path)
  }
  if (line < 0 || line >= lines.length) {
    return { from: 0, to: Math.min(text.length, (lines[0] ?? '').length) }
  }
  const start = starts[line] as number
  const end = start + (lines[line] ?? '').length
  if (problem.line === undefined || problem.column === undefined) {
    return { from: start, to: end }
  }
  const from = Math.min(start + problem.column - 1, end)
  const word = WORD_RE.exec(text.slice(from, end))?.[0].length ?? 0
  return { from, to: Math.max(from, Math.min(from + word, end)) }
}
