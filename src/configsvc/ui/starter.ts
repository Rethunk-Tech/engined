/** Proposing a first config.toml from what the host can run and what is shipped. */

import type { ShippedEngine } from '../../configsvcShipped.ts'
import type { EditOp } from '../../editOps.ts'
import type { ModelFile } from './data.ts'

export interface DoctorCheck {
  id: string
  ok: boolean
  detail: string
  fix?: string
  skipped?: boolean
}

export type Candidate = ShippedEngine & { files: ModelFile[] }

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
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

export interface Pick {
  engine: Candidate
  /** Weights to route to: a role for a llama file, none for the single-role kinds. */
  files: { path: string; role?: string }[]
}

/** Edits that turn an empty config into the proposal: the local upstream, the chosen engines and their routes. */
export function starterOps(picks: readonly Pick[]): EditOp[] {
  const ops: EditOp[] = [
    { op: 'addEntry', table: 'upstream', entry: { id: 'local', egress: 'none' } },
  ]
  for (const { engine, files } of picks) {
    ops.push({
      op: 'addEntry',
      table: 'engine',
      entry:
        engine.models_dir === undefined
          ? { id: engine.id }
          : { id: engine.id, models_dir: engine.models_dir },
    })
    if (engine.kind === 'agentic-cli') {
      ops.push({ op: 'addEntry', table: 'route', entry: { engine: engine.id } })
    } else if (engine.kind === 'tts' || engine.kind === 'comfy') {
      ops.push({ op: 'addEntry', table: 'route', entry: { engine: engine.id, upstream: 'local' } })
    }
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
