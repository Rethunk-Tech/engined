/**
 * The local test tier loads the operator's real `config.example.toml`, and
 * `loadConfig` refuses the whole file when any one route's weights are absent
 * from this box. These helpers drop just the routes whose files are missing so
 * every other suite still runs, and name each missing file for the skip reason.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { loadConfig } from './config.ts'
import type { Config } from './types.ts'

const MISSING_FILENAME = /"filename" does not exist at "([^"]+)"/
const TABLE_HEADER = /^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*(#.*)?$/
const FILENAME_LINE = /^\s*filename\s*=\s*"([^"]*)"/

/** Each `[[route]]` block with its `[route.*]` sub-tables, as `[start, end)` line ranges. */
function routeBlocks(lines: readonly string[]): [number, number][] {
  const blocks: [number, number][] = []
  let start = -1
  const close = (end: number): void => {
    if (start !== -1) {
      blocks.push([start, end])
      start = -1
    }
  }
  lines.forEach((line, i) => {
    const header = TABLE_HEADER.exec(line)?.[1]
    if (header === undefined) {
      return
    }
    if (header === 'route' && line.trimStart().startsWith('[[')) {
      close(i)
      start = i
    } else if (!header.startsWith('route.')) {
      close(i)
    }
  })
  close(lines.length)
  return blocks
}

/** `toml` without every `[[route]]` block (and its sub-tables) whose `filename` is `filename`; `dropped` counts them. */
export function dropRoutesWithFilename(
  toml: string,
  filename: string,
): { toml: string; dropped: number } {
  const lines = toml.split('\n')
  const drop = routeBlocks(lines).filter(([from, to]) =>
    lines.slice(from, to).some((l) => FILENAME_LINE.exec(l)?.[1] === filename),
  )
  const kept = lines.filter((_, i) => !drop.some(([from, to]) => i >= from && i < to))
  return { toml: kept.join('\n'), dropped: drop.length }
}

/** The `filename` values in `toml` that `target` (an absolute path) ends with. */
function filenameFor(toml: string, target: string): string | undefined {
  return toml
    .split('\n')
    .map((l) => FILENAME_LINE.exec(l)?.[1])
    .find((name) => name !== undefined && target.endsWith(`/${name}`))
}

/**
 * `loadConfig(file)`, except that a route whose weights file is absent is dropped
 * (and its path reported in `missing`) instead of failing the whole load. Any
 * other error propagates. The pruned copy sits beside `file` so relative paths
 * and `config.d` resolve as for the real one, and is removed before returning.
 */
export function loadConfigWithoutMissingWeights(
  file: string,
  enginesRoot: string,
): { config: Config; missing: string[] } {
  const missing: string[] = []
  let toml = readFileSync(file, 'utf8')
  const copy = join(dirname(file), `.pruned-${process.pid}.toml`)
  try {
    for (;;) {
      let current = file
      if (missing.length > 0) {
        writeFileSync(copy, toml)
        current = copy
      }
      try {
        return { config: loadConfig(current, enginesRoot), missing }
      } catch (err) {
        const target = MISSING_FILENAME.exec(err instanceof Error ? err.message : '')?.[1]
        const filename = target === undefined ? undefined : filenameFor(toml, target)
        if (target === undefined || filename === undefined || missing.includes(target)) {
          throw err
        }
        missing.push(target)
        ;({ toml } = dropRoutesWithFilename(toml, filename))
      }
    }
  } finally {
    if (existsSync(copy)) {
      rmSync(copy)
    }
  }
}
