/**
 * Cache-aware slot placement for a local llama route running `parallel >= 2`.
 *
 * Measured problem (operator's real VS Code Copilot chats on ornith,
 * llama-server logs): a new chat's ~31k-token prompt, identical in its first
 * ~30k tokens to the previous chat's, is fully re-prefilled (47-50 s) because
 * Copilot's small side requests (10-276 tokens) land by llama's own
 * cross-request LRU on the slot holding the long cached prompt and overwrite
 * it. llama-server honours a caller-supplied `"id_slot": N` on the wire
 * (`selected slot by id (N)` in its own log); `GET /slots` reports no cache
 * contents, so this door has to track what it placed itself.
 *
 * The first `ceil(parallel / 2)` slot ids are reserved LONG: a caller whose
 * prompt is at or above the threshold lands there, on the slot whose tracked
 * prefix fingerprint matches when one is idle, else the least-recently-used
 * idle long slot. Every other slot is SHORT, and a short prompt never lands
 * on a long one -- that is the whole point, since it is the small requests
 * landing on the long slot that were overwriting the cached prefix. Neither
 * class touches the other's slots even when its own are all busy: `id_slot`
 * is simply left unset, and llama-server decides on its own.
 */

import { createHash } from 'node:crypto'
import { bpeTokenIds } from './bpeTokenize.ts'
import { loadBpeVocab } from './bpeVocab.ts'
import { isRecord } from './types.ts'

export type SlotSizeClass = 'long' | 'short'

/** Config default when a route leaves `slot_long_threshold` undeclared. */
export const DEFAULT_SLOT_LONG_THRESHOLD = 4096

/** How many of a long prompt's leading tokens identify its prefix -- enough to tell one Copilot chat's history from another's without hashing the whole 30k-token prompt on every request. */
const FINGERPRINT_TOKEN_COUNT = 2048

/** Used only when the route's GGUF vocab cannot be read cold (see `classifyPrompt`). Rough, but it only has to place a request in the right size class, not count it exactly. */
const FALLBACK_CHARS_PER_TOKEN = 3

interface Slot {
  id: number
  sizeClass: SlotSizeClass
  fingerprint: string | undefined
  lastUsedMs: number
  busy: boolean
}

/** One engine+model's slot occupancy, held in memory for the life of the `LlamaRouter` that owns it. */
export class LlamaSlotTable {
  readonly parallel: number
  private readonly slots: Slot[]

  constructor(parallel: number) {
    this.parallel = parallel
    const longCount = Math.ceil(parallel / 2)
    this.slots = Array.from({ length: parallel }, (_unused, id) => ({
      id,
      sizeClass: id < longCount ? 'long' : 'short',
      fingerprint: undefined,
      lastUsedMs: 0,
      busy: false,
    }))
  }

  /**
   * Marks a slot busy and returns its id, or `undefined` to leave `id_slot`
   * unset -- no slot of this size class is idle, so llama-server's own
   * choice is no worse than a guess this table cannot back up.
   */
  acquire(sizeClass: SlotSizeClass, fingerprint: string | undefined): number | undefined {
    const idle = this.slots.filter((s) => s.sizeClass === sizeClass && !s.busy)
    if (idle.length === 0) {
      return undefined
    }
    const matched =
      fingerprint === undefined ? undefined : idle.find((s) => s.fingerprint === fingerprint)
    const chosen = matched ?? oldest(idle)
    chosen.busy = true
    return chosen.id
  }

  /** Clears the busy flag and records this prompt's own fingerprint as what the slot now holds -- read back by the next `acquire` for the same prefix. Silently a no-op for an id this table never handed out (a config reload rebuilt the table mid-flight). */
  release(id: number, fingerprint: string | undefined, nowMs: number): void {
    const slot = this.slots.find((s) => s.id === id)
    if (slot === undefined) {
      return
    }
    slot.busy = false
    slot.lastUsedMs = nowMs
    if (slot.sizeClass === 'long') {
      slot.fingerprint = fingerprint
    }
  }
}

function oldest(slots: readonly Slot[]): Slot {
  return slots.reduce((least, s) => (s.lastUsedMs < least.lastUsedMs ? s : least))
}

/** A GPT-2-BPE-vocab-backed token count and prefix fingerprint, or a chars/3 estimate with no fingerprint when the vocab can't be read cold. */
export interface PromptClassification {
  sizeClass: SlotSizeClass
  tokens: number
  fingerprint: string | undefined
}

async function tokenIdsOf(ggufPath: string, text: string): Promise<number[] | undefined> {
  try {
    const vocab = await loadBpeVocab(ggufPath)
    return bpeTokenIds(vocab, text)
  } catch {
    return undefined
  }
}

function fingerprintOf(ids: readonly number[]): string {
  return createHash('sha256').update(ids.slice(0, FINGERPRINT_TOKEN_COUNT).join(',')).digest('hex')
}

/**
 * `ggufPath` absent, or its vocab unreadable cold, falls back to chars/3 with
 * no fingerprint: still enough to place the request in the right size class,
 * just never enough to match it back to a specific cached prefix.
 */
export async function classifyPrompt(
  ggufPath: string | undefined,
  text: string,
  longThresholdTokens: number,
): Promise<PromptClassification> {
  const ids = ggufPath === undefined ? undefined : await tokenIdsOf(ggufPath, text)
  const tokens = ids?.length ?? Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN)
  const sizeClass: SlotSizeClass = tokens >= longThresholdTokens ? 'long' : 'short'
  return {
    sizeClass,
    tokens,
    fingerprint: sizeClass === 'long' && ids !== undefined ? fingerprintOf(ids) : undefined,
  }
}

function messageText(message: unknown): string {
  if (!isRecord(message)) {
    return ''
  }
  const { content } = message
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/**
 * The text a request's own prompt is made of, concatenated -- exact template
 * rendering is not needed, only enough text to size and fingerprint the
 * prompt. Chat's `messages`, or completions/infill's `prompt`/
 * `input_prefix`+`input_suffix`. Empty for a body with none of those
 * (embeddings' `input`, rerank's `documents`), which classifies as `short`
 * with nothing to place -- harmless, since nothing here is chat traffic
 * Copilot's cache-locality problem applies to.
 */
export function renderedPromptText(body: Record<string, unknown>): string {
  if (Array.isArray(body.messages)) {
    return body.messages.map(messageText).join('\n')
  }
  if (typeof body.prompt === 'string') {
    return body.prompt
  }
  if (typeof body.input_prefix === 'string' || typeof body.input_suffix === 'string') {
    return `${body.input_prefix ?? ''}${body.input_suffix ?? ''}`
  }
  return ''
}
