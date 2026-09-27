/**
 * Which submitted prompt belongs to which caller, kept across restarts so a
 * caller can still fetch its own output after one. Aged out and capped, since
 * nothing else ever deletes an entry.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
/** NUL, so the composed key stays unambiguous and `startsWith` can scope a scan to one (engine, origin) pair: no engine id, origin or `prompt_id` can contain one. */
import type { ComfyBinding, ComfyBindings, DoorContext } from './doorContext.ts'
import { stateDir } from './paths.ts'
import { writeToStdout } from './provenance.ts'
import { errMessage, isRecord, MS_PER_SECOND, parseRecord } from './records.ts'
export const COMFY_KEY_SEP = '\u0000'

export function comfyKey(engineId: string, origin: string, promptId: string): string {
  return `${engineId}${COMFY_KEY_SEP}${origin}${COMFY_KEY_SEP}${promptId}`
}

/**
 * The binding table on disk: ids and filenames only, never a request body --
 * a `prompt_id` is comfy's job handle, not the prompt that produced it.
 * It outlives the process because a restart that forgot a binding would
 * refuse a stored output to the very caller that created it.
 */
export function comfyBindingsPath(): string {
  return join(stateDir(), 'comfy-bindings.json')
}

/**
 * Dropping what this build cannot read is the safe direction, but doing it
 * without a line is what makes a state-format change indistinguishable from
 * comfy having produced nothing: every stored output stops resolving and the
 * table looks the way an idle week looks. The line is a count, never a key --
 * a key carries the prompt id that produced it.
 */
export function loadComfyBindings(write: (line: string) => void = writeToStdout): ComfyBindings {
  let text = ''
  try {
    text = readFileSync(comfyBindingsPath(), 'utf8')
  } catch {
    // No table yet. An empty one refuses every stored output, which is the
    // safe direction to fail, and so is a file this build cannot read.
  }
  const raw = parseRecord(text)
  if (raw === null) {
    // An absent table is the ordinary first start; one that will not parse is
    // a table voided whole, which is worth telling apart from it.
    if (text !== '') {
      write(JSON.stringify({ comfy_bindings: 'unreadable', dropped: 'all', kept: 0 }))
    }
    return new Map()
  }
  // Age is not filtered here. Every read goes through `liveBinding`, so an
  // aged entry read back is refused all the same and the next save drops it --
  // one mechanism deciding what is servable, rather than two that can disagree
  // about where the boundary is.
  let dropped = 0
  const table = new Map(
    Object.entries(raw).flatMap(([key, value]): [string, ComfyBinding][] => {
      // Anything not of this shape is dropped rather than repaired: an entry
      // this build cannot read is an entry it cannot vouch for, and an empty
      // table refuses stored outputs, which is the safe direction to fail.
      if (!isRecord(value) || typeof value.at !== 'number' || !Array.isArray(value.filenames)) {
        dropped += 1
        return []
      }
      return [
        [key, { at: value.at, filenames: value.filenames.filter((n) => typeof n === 'string') }],
      ]
    }),
  )
  if (dropped > 0) {
    write(JSON.stringify({ comfy_bindings: 'partial', dropped, kept: table.size }))
  }
  return table
}

/**
 * How long a binding is served for. The count bound below is not enough on its
 * own: it is a bound on the TABLE, so a quiet week leaves a binding servable
 * and a busy hour expires one minutes old, and neither is something a consumer
 * can plan around. Age is, so `GET /view` can be described to a caller: fetch
 * an output within a week of producing it.
 *
 * Long enough that a consumer generating today and fetching tomorrow is never
 * surprised, short enough that the table does not accumulate a binding per
 * prompt forever on a box that renders daily.
 */
const COMFY_BINDING_TTL_MS = 7 * 24 * 60 * 60 * MS_PER_SECOND

/** Whether a binding bound at `at` has aged out. */
export function expired(at: number, now: number): boolean {
  return now - at >= COMFY_BINDING_TTL_MS
}

/**
 * The binding for this key if it is still servable. Checked on read and not
 * only at save time: eviction happens when something is written, so between
 * two writes a table in memory still holds bindings that have aged out, and
 * serving one because nothing has been saved lately would make expiry depend
 * on unrelated traffic.
 */
export function liveBinding(ctx: DoorContext, key: string): ComfyBinding | undefined {
  const bound = ctx.comfyBindings.get(key)
  return bound !== undefined && !expired(bound.at, Date.now()) ? bound : undefined
}

/**
 * How many bindings the table keeps. Count, not age: a `prompt_id` carries no
 * timestamp and adding one would mean a second on-disk shape to read back,
 * where `Map` iteration order already puts the oldest binding first.
 *
 * Evicting a binding is what makes `GET /view` refuse an output the door
 * itself produced, so this is set well above what a session plausibly
 * generates rather than as tight as the file could bear -- ~108 bytes per
 * binding measured, so the whole table stays under ~108 KB at 1000 entries.
 *
 * Two shortcuts are held up by this cap and are what to revisit before
 * raising it: the whole-table rewrite on every save just below, and
 * `comfyFilenameBound`'s linear scan.
 */
const COMFY_BINDINGS_MAX = 1000

// ponytail: the whole table is rewritten on every bind and every filename this
// door had not already recorded -- bounded work, since COMFY_BINDINGS_MAX
// bounds the table and the age bound only shrinks it further. An append log
// only earns its complexity if that cap is ever raised far enough for the
// rewrite to be felt.
/**
 * The eviction lands only once the write has. A full disk or an unwritable
 * state dir would otherwise shrink the table in memory while the file keeps
 * the larger set, and the door would refuse an output it can still see on
 * disk with nothing said. So a failed write evicts nothing, leaving the
 * table a superset of what the file describes -- every binding the file
 * holds is still served, plus the ones that never reached it, which is the
 * direction that refuses nothing. The failure reports itself and the call it
 * belongs to still answers: the caller's own request succeeded, and only the
 * unwritten bindings are lost, at the next restart.
 */
export function saveComfyBindings(bindings: ComfyBindings): void {
  // Two bounds, age first and then count. A binding is inserted when its
  // prompt is queued and only mutated in place afterwards, so insertion order
  // is creation order and the oldest survivors are the ones the count drops.
  const now = Date.now()
  const live: [string, ComfyBinding][] = []
  const evicted: string[] = []
  for (const [key, bound] of bindings) {
    if (expired(bound.at, now)) {
      evicted.push(key)
    } else {
      live.push([key, bound])
    }
  }
  const overCount = Math.max(0, live.length - COMFY_BINDINGS_MAX)
  const kept = live.slice(overCount)
  evicted.push(...live.slice(0, overCount).map(([key]) => key))
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(comfyBindingsPath(), JSON.stringify(Object.fromEntries(kept)))
  } catch (err) {
    process.stderr.write(`comfy bindings not persisted: ${errMessage(err)}\n`)
    return
  }
  for (const key of evicted) {
    bindings.delete(key)
  }
}
