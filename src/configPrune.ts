/**
 * `engined --prune-config FILE --out FILE`: writes a copy of the config without
 * the declared routes model discovery makes redundant (`duplicate`) or stale
 * (`retired`), exactly the ones `GET /engined/v1/engines` reports as findings.
 *
 * It edits text, not parsed data, so every other byte (comments, ordering,
 * formatting) survives. It asks each provider afresh and refuses if any served
 * engine cannot be reached: an offline box must not delete routes it cannot
 * prove redundant.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

import { loadConfig } from './config.ts'
import { fragmentFiles } from './configSources.ts'
import { FatalError } from './errors/fatal.ts'
import { dropRanges, tableBlocks } from './localConfigPrune.ts'
import { ModelDiscovery } from './modelDiscovery.ts'
import { SOURCES } from './modelSources.ts'
import { errMessage, isRecord } from './records.ts'

const BLANK_OR_COMMENT = /^\s*(#.*)?$/

interface PruneRemoval {
  kind: 'duplicate' | 'retired' | 'model'
  engine?: string
  /** A route's `model`, or a `[[model]]`'s `id`. */
  name: string
  file: string
}

interface PruneResult {
  removals: PruneRemoval[]
  /** Where each source file was written. */
  written: string[]
}

type Targets = Map<string, 'duplicate' | 'retired'>

const targetKey = (engine: string, model: string): string => `${engine}\0${model}`

function blockTable(lines: readonly string[], from: number, to: number): Record<string, unknown> {
  const parsed = Bun.TOML.parse(lines.slice(from, to).join('\n'))
  const entries = Object.values(parsed)[0]
  const first = Array.isArray(entries) ? entries[0] : undefined
  return isRecord(first) ? first : {}
}

/** `[from, to)` widened to swallow the blank lines after the block's last content line, leaving the comments that belong to the next block. */
function removalRange(lines: readonly string[], from: number, to: number): [number, number] {
  let end = to
  while (end > from + 1 && BLANK_OR_COMMENT.test(lines[end - 1] as string)) {
    end -= 1
  }
  let stop = end
  while (stop < lines.length - 1 && (lines[stop] as string).trim() === '') {
    stop += 1
  }
  return [from, stop]
}

/** Routes of `engine`/`model` named in `targets` with no `upstream`, dropped from one file's text. */
function pruneRoutes(
  text: string,
  file: string,
  targets: Targets,
): { text: string; removals: PruneRemoval[]; models: Set<string> } {
  const lines = text.split('\n')
  const ranges: [number, number][] = []
  const removals: PruneRemoval[] = []
  const models = new Set<string>()
  for (const [from, to] of tableBlocks(lines, 'route')) {
    const block = blockTable(lines, from, to)
    const { engine, model } = block
    if (typeof engine !== 'string' || typeof model !== 'string' || block.upstream !== undefined) {
      continue
    }
    const kind = targets.get(targetKey(engine, model))
    if (kind !== undefined && block.disable !== true) {
      ranges.push(removalRange(lines, from, to))
      removals.push({ kind, engine, name: model, file })
      models.add(model)
    }
  }
  return { text: dropRanges(lines, ranges), removals, models }
}

function usedModels(text: string): Set<string> {
  const lines = text.split('\n')
  const used = new Set<string>()
  for (const [from, to] of tableBlocks(lines, 'route')) {
    const { model } = blockTable(lines, from, to)
    if (typeof model === 'string') {
      used.add(model)
    }
  }
  return used
}

/** `[[model]]` blocks among `candidates` that no route in `still` uses. */
function pruneModels(
  text: string,
  file: string,
  candidates: ReadonlySet<string>,
  still: ReadonlySet<string>,
): { text: string; removals: PruneRemoval[] } {
  const lines = text.split('\n')
  const ranges: [number, number][] = []
  const removals: PruneRemoval[] = []
  for (const [from, to] of tableBlocks(lines, 'model')) {
    const { id } = blockTable(lines, from, to)
    if (typeof id === 'string' && candidates.has(id) && !still.has(id)) {
      ranges.push(removalRange(lines, from, to))
      removals.push({ kind: 'model', name: id, file })
    }
  }
  return { text: dropRanges(lines, ranges), removals }
}

export async function pruneConfig({
  file,
  out,
  enginesRoot,
  discovery,
}: {
  file: string
  out: string
  enginesRoot?: string
  /** Defaults to a fresh `ModelDiscovery` on a scratch state dir, so the operator's cache is untouched. */
  discovery?: ModelDiscovery
}): Promise<PruneResult> {
  const config = loadConfig(file, enginesRoot)
  // The scratch state dir exists only so the operator's discovery cache is untouched; it goes when the prune does.
  const scratch =
    discovery === undefined ? mkdtempSync(join(tmpdir(), 'engined-prune-')) : undefined
  const asker = discovery ?? new ModelDiscovery({ stateRoot: scratch as string })
  try {
    const served = config.engines.filter((e) => !e.disabled && SOURCES[e.id] !== undefined)
    for (const engine of served) {
      await asker.refresh(engine.id)
    }
    const status = asker.apply(config).model_discovery ?? {}
    for (const engine of served) {
      const s = status[engine.id]
      if (s?.fetched_at === undefined || s.last_error !== undefined) {
        throw new Error(
          `refusing to prune: the provider list for "${engine.id}" could not be fetched (${s?.last_error ?? 'no answer'}); nothing is deleted that cannot be proved redundant`,
        )
      }
    }
    const targets: Targets = new Map()
    for (const [engine, s] of Object.entries(status)) {
      for (const f of s.findings) {
        targets.set(targetKey(engine, f.route), f.kind)
      }
    }

    const files = [file, ...fragmentFiles(file)]
    const routePass = files.map((f) => pruneRoutes(readFileSync(f, 'utf8'), f, targets))
    const removedModels = new Set(routePass.flatMap((p) => [...p.models]))
    const still = new Set(routePass.flatMap((p) => [...usedModels(p.text)]))
    const removals: PruneRemoval[] = routePass.flatMap((p) => p.removals)
    const written: string[] = []
    for (const [i, f] of files.entries()) {
      const modelPass = pruneModels(
        (routePass[i] as { text: string }).text,
        f,
        removedModels,
        still,
      )
      removals.push(...modelPass.removals)
      const dest = i === 0 ? out : join(dirname(out), 'config.d', basename(f))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, modelPass.text)
      written.push(dest)
    }
    loadConfig(out, enginesRoot)
    return { removals, written }
  } finally {
    if (scratch !== undefined) {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

/** The `--prune-config` command: prints what it removed and returns the exit code. */
export async function pruneCli(
  argv: readonly string[],
  write: (line: string) => void,
): Promise<number> {
  const file = flagValue(argv, '--prune-config')
  const out = flagValue(argv, '--out')
  if (file === undefined || out === undefined || file === out) {
    process.stderr.write('engined: --prune-config and --out must name different files\n')
    return FatalError.USAGE_EXIT_CODE
  }
  try {
    const { removals, written } = await pruneConfig({ file, out })
    for (const r of removals) {
      write(
        `removed ${r.kind} ${r.engine === undefined ? '' : `${r.engine}/`}${r.name} (${r.file})`,
      )
    }
    const routes = removals.filter((r) => r.kind !== 'model')
    const engines = [...new Set(routes.map((r) => r.engine))].sort(
      (a, b) => Number(String(a) > String(b)) - Number(String(a) < String(b)),
    )
    write(
      `removed ${routes.length} routes (${engines.map((e) => `${e}: ${routes.filter((r) => r.engine === e).length}`).join(', ')}) and ${removals.length - routes.length} models; wrote ${written.join(', ')}`,
    )
    return 0
  } catch (err) {
    process.stderr.write(`engined: ${errMessage(err)}\n`)
    return 1
  }
}
