/** What the `--probe` families share: the menu row they read, the line they print, and the loop between them. */

import { ENGINE_ERROR_CHARS, errorMessageOf, STATUS_UNAVAILABLE } from './http.ts'
import type { ProbeKind } from './probeStore.ts'
import { parseRecord } from './records.ts'

/** One line per address the door offers, in the order the menu listed them. */
export interface ProbeLine {
  address: string
  ok: boolean
  detail: string
  /** Set on the translation and rerank lines, the two the door records; see `reportProbes`. */
  kind?: ProbeKind
  skip?: boolean
}

/**
 * A probed engine that answers 503 is a failed proof with the door's own
 * reason; any other non-success is a failed proof too.
 */
export function httpProbeError(
  status: number,
  raw: string,
): { ok: boolean; skip?: boolean; detail: string } {
  const clipped = raw.slice(0, ENGINE_ERROR_CHARS)
  if (status === STATUS_UNAVAILABLE) {
    return {
      ok: false,
      detail: errorMessageOf(parseRecord(clipped) ?? {}) ?? clipped,
    }
  }
  return { ok: false, detail: `http ${status}: ${clipped}` }
}

/** The subset of a `/openai/v1/models` row this probe reads. Parsed from the wire, so it is narrowed here rather than imported: a row is whatever the running door sent, not whatever this build's `ModelRow` says. */
export interface MenuRow {
  id?: unknown
  role?: unknown
  vision?: unknown
  state?: unknown
  translate?: unknown
  serves?: unknown
}

/**
 * Whether this address can answer a probe at all.
 *
 * `unavailable` is the only state worth skipping for rerank, translations and
 * completions: `GET /engined/v1/engines` already reports why, with the literal
 * command that fixes it, and a probe repeating that in a different voice adds
 * nothing.
 *
 * Vision does not skip. A configured vision route that cannot be asked fails
 * the run (`probeVision`); filtering it out here would be a green result that
 * checked nothing.
 *
 * NOT `state === "installed"`, which is what this checked first and which
 * quietly meant "prove nothing whenever the engine is already up" -- a
 * running engine reports `running`, so a box mid-use skipped every address it
 * had. That is the silence this module exists to end, so the test below pins
 * it.
 */
export function canAnswer(state: unknown): boolean {
  return typeof state === 'string' && state !== 'unavailable'
}

export type KeptRow = MenuRow & { id: string }

/** Every row `keep` selects, asked `one` in menu order; a menu with none of them yields no lines. */
export async function eachRow(
  rows: readonly MenuRow[],
  keep: (row: MenuRow) => boolean,
  one: (row: KeptRow) => Promise<{ ok: boolean; detail: string; skip?: boolean }>,
): Promise<ProbeLine[]> {
  const lines: ProbeLine[] = []
  for (const row of rows) {
    if (keep(row) && typeof row.id === 'string') {
      lines.push({ address: row.id, ...(await one({ ...row, id: row.id })) })
    }
  }
  return lines
}
