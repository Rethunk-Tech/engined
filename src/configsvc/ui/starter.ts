/** Proposing a first config.toml from what the host can run and what is shipped. */

import type { ShippedEngine } from '../../configsvcShipped.ts'
import type { EditOp } from '../../editOps.ts'
import type { DoctorCheck, ModelFile } from './data.ts'

export type { DoctorCheck }

export type Candidate = ShippedEngine & { files: ModelFile[] }

const FILE_EXT_RE = /\.[^.]+$/
const NON_ID_RE = /[^A-Za-z0-9._-]+/g
const TRIM_DOT_RE = /^[-.]+|[-.]+$/g

/** The failed doctor checks that would stop this engine from running. */
export function blockers(engine: ShippedEngine, checks: readonly DoctorCheck[]): DoctorCheck[] {
  const needed = new Set<string>(engine.devices)
  if (engine.kind !== 'agentic-cli') {
    needed.add('docker')
  }
  if (engine.agent !== undefined) {
    needed.add(`agent ${engine.agent}`)
  }
  if (engine.agent === 'opencode') {
    needed.add('bwrap')
  }
  return checks.filter((c) => !c.ok && needed.has(c.id))
}

/** Engines worth proposing: those with nothing blocking them, minus the one that ships disabled. */
export function proposedByDefault(engine: ShippedEngine, blocked: readonly DoctorCheck[]): boolean {
  return (
    blocked.length === 0 &&
    engine.id !== 'cursor' &&
    ['openai-http', 'stt', 'agentic-cli'].includes(engine.kind)
  )
}

/** A model id (no slash, no INI breakers) from a weights file name. */
export function modelIdFromFile(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(FILE_EXT_RE, '').replace(NON_ID_RE, '-').replace(TRIM_DOT_RE, '')
}

/** An engine that serves nothing until a route names a weights file under its models_dir. */
export function needsWeights(engine: ShippedEngine): boolean {
  return engine.models_dir !== undefined && (engine.kind === 'openai-http' || engine.kind === 'stt')
}

export interface Pick {
  engine: Candidate
  /** Weights to route to: a role for a llama file, none for the single-role kinds. */
  files: { path: string; role?: string }[]
}

export const LOCAL_UPSTREAM_OP: EditOp = {
  op: 'addEntry',
  table: 'upstream',
  entry: { id: 'local', egress: 'none' },
}

/** A shipped engine's `[[engine]]` entry and, for the kinds that need no weights file, its one route. */
export function engineOps(engine: ShippedEngine, roles = 1): EditOp[] {
  const ops: EditOp[] = [
    {
      op: 'addEntry',
      table: 'engine',
      entry:
        engine.models_dir === undefined
          ? { id: engine.id }
          : engine.kind === 'openai-http'
            ? // The llama spec takes --models-max from config and has no default of its own.
              { id: engine.id, models_dir: engine.models_dir, models_max: Math.max(1, roles) }
            : { id: engine.id, models_dir: engine.models_dir },
    },
  ]
  if (engine.kind === 'agentic-cli') {
    ops.push({ op: 'addEntry', table: 'route', entry: { engine: engine.id } })
  } else if (engine.kind === 'tts' || engine.kind === 'comfy') {
    ops.push({ op: 'addEntry', table: 'route', entry: { engine: engine.id, upstream: 'local' } })
  }
  return ops
}

/** Edits that turn an empty config into the proposal: the local upstream, the chosen engines and their routes. */
export function starterOps(picks: readonly Pick[]): EditOp[] {
  const ops: EditOp[] = [LOCAL_UPSTREAM_OP]
  for (const { engine, files } of picks) {
    if (needsWeights(engine) && files.length === 0) {
      continue
    }
    ops.push(...engineOps(engine, new Set(files.map((f) => f.role ?? 'chat')).size))
    for (const file of files) {
      ops.push({
        op: 'addEntry',
        table: 'route',
        entry: {
          engine: engine.id,
          upstream: 'local',
          model: modelIdFromFile(file.path),
          filename: file.path,
          ...(file.role === undefined ? {} : { role: file.role }),
        },
      })
    }
  }
  return ops
}
