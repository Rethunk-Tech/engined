/**
 * The presets INI and the container spec one llama.cpp engine runs under.
 *
 * `--models-preset` is the only channel proven to reach a child's argv — a
 * `POST /models/load` with an `args` array left argv unchanged in the probe
 * that established this design. Every per-model flag therefore goes through
 * the INI, never through the load call's body.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ParseError } from './errors/parse.ts'
import { localRoutesOf } from './routeAddress.ts'
import { loadSpec, type SpecLoadOptions } from './spec.ts'
import type { RunnableContainerSpec } from './specTypes.ts'
import { isContainerSpec } from './specTypes.ts'
import type { EngineEntry, ResolvedRoute } from './types.ts'

export const PRESET_CONTAINER_PATH = '/preset.ini'
export const MODELS_CONTAINER_PATH = '/models'

function iniLines(args: Record<string, unknown>): string[] {
  return Object.entries(args).map(([k, v]) => `${k} = ${String(v)}`)
}

/** `undefined` on a first start (nothing mounted yet) rather than throwing -- absence is the normal case, not an error. */
export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * The slot count llama.cpp's `parallel = -1` auto resolves to: four on the pinned
 * build (`docs/tuning.md`), sharing one unified
 * KV pool rather than four windows. The door needs a number to admit against
 * when a role leaves the key at auto; this is the child's real one. Proven
 * against the live child by `test/local/llama.test.ts`, which reads this
 * same number back from llama-server's own `GET /props?model=<id>` for a
 * route left at auto rather than trusting the measurement above to still
 * hold. Exported so that test can compare against it rather than a second
 * copy of the constant.
 */
export const AUTO_PARALLEL = 4

/**
 * Precedence in one place: a route key beats the engine key naming it. The
 * preset INI and the door's own capacity ceiling must read the same merged
 * table, or the door admits a concurrency the child never agreed to.
 */
export function mergedArgs(
  engine: EngineEntry,
  route: { args: Record<string, unknown> } | undefined,
): Record<string, unknown> {
  return { ...engine.args, ...route?.args }
}

/** The merged `parallel` when it is a positive integer the door can admit against; `undefined` for auto (`-1`) or an unset/non-integer key, which is `AUTO_PARALLEL` at the call site. */
export function explicitParallel(
  engine: EngineEntry,
  route: { args: Record<string, unknown> } | undefined,
): number | undefined {
  const { parallel } = mergedArgs(engine, route)
  return typeof parallel === 'number' && Number.isInteger(parallel) && parallel > 0
    ? parallel
    : undefined
}

/**
 * One `[model]` section per route on this engine. A route's section starts
 * from the engine's process-flag defaults and layers the route's own on top
 * — a route key beats the engine key naming it — then passes the merged
 * table through as INI keys verbatim. A headless GGUF's `[route.args]` simply
 * omits `spec-*`, so MTP never applies process-wide by construction.
 */
export function renderPresetIni(engine: EngineEntry, routes: readonly ResolvedRoute[]): string {
  return routes
    .filter(
      (r): r is ResolvedRoute & { filename: string; model: string } =>
        r.engine === engine.id && r.filename !== undefined && r.model !== undefined,
    )
    .map((r) => {
      const args = mergedArgs(engine, r)
      const lines = [`model = ${MODELS_CONTAINER_PATH}/${r.filename}`, ...iniLines(args)]
      return `[${r.model}]\n${lines.join('\n')}`
    })
    .join('\n\n')
}

/**
 * Composes `loadSpec` (structural: `--models-preset`/`--models-max`/
 * `--no-models-autoload`, never edited here) with the two bind mounts.
 *
 * `engine.args` deliberately does NOT go on the command line. A CLI flag
 * overrides the preset for every model llama-server loads, so passing the
 * engine's defaults here would flatten each `[model.args]` back to the
 * engine value -- which is exactly how a model's own `ctx-size` came to be
 * silently ignored. `renderPresetIni` already layers the engine's defaults
 * under each model's section, so the child gets them either way, and only
 * this path lets a model override one.
 */
export function buildLlamaSpec(
  engine: EngineEntry,
  opts: SpecLoadOptions,
  presetHostPath: string,
): RunnableContainerSpec {
  const loaded = loadSpec(engine, {
    enginesRoot: opts.enginesRoot,
    bunx: opts.bunx,
    presetIni: PRESET_CONTAINER_PATH,
  })
  if (!isContainerSpec(loaded.spec)) {
    throw new ParseError(
      `engine "${engine.id}": llama spec must be a container spec`,
      loaded.source,
    )
  }
  if (engine.models_dir === undefined) {
    throw new ParseError(`engine "${engine.id}": llama engine has no models_dir`, loaded.source)
  }
  const { spec } = loaded
  spec.volumes = [
    ...spec.volumes,
    { name: engine.models_dir, path: MODELS_CONTAINER_PATH, read_only: true },
    { name: presetHostPath, path: PRESET_CONTAINER_PATH, read_only: true },
  ]
  return spec
}

/**
 * The bind-mounted INI llama-server reads once at startup, re-rendered on
 * every start so a config edit to `[[route]]`/`[engine.args]` reaches the
 * container the next time it actually starts, per the reload rule. Filtered
 * on `(engine, upstream === "local")`: a route proxied to a peer's llama
 * has nothing resident on this box to render a section for.
 */
export function writeLocalPreset(
  path: string,
  engine: EngineEntry,
  allRoutes: readonly ResolvedRoute[],
): void {
  const routes = localRoutesOf(allRoutes, engine.id)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderPresetIni(engine, routes), 'utf8')
}
