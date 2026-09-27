/**
 * Cursor's own model catalog names every (base, reasoning depth, priority
 * tier) combination as one flat id -- `claude-opus-5-thinking-medium-fast` is
 * base `claude-opus-5`, thinking on, effort `medium`, priority tier. This is
 * the one place that grammar is parsed, so the address book (`modelsMenu.ts`)
 * and the dispatcher (`dispatch.ts`) can never disagree about what an id means.
 *
 * The ladder a caller's `reasoning_effort` walks, lowest to highest. `none`
 * doubles as "thinking off" for a base that has `-thinking` variants at all --
 * Cursor's own non-thinking siblings keep whatever effort word is in their id,
 * but that word is cosmetic there (it does not mean this door can address a
 * `-high` non-thinking sibling next to a `-thinking-high` one by word alone),
 * so every non-thinking sibling collapses onto `none`. Where a base offers
 * several such siblings only the lowest-effort one stays reachable by level;
 * the others still exist in Cursor's catalog but have no address of their own
 * through this door -- a real loss of resolution the flat ladder cannot avoid.
 */
export const CURSOR_EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type CursorEffort = (typeof CURSOR_EFFORT_ORDER)[number]

const CURSOR_EFFORT_SET: ReadonlySet<string> = new Set(CURSOR_EFFORT_ORDER)

function isCursorEffort(value: string): value is CursorEffort {
  return CURSOR_EFFORT_SET.has(value)
}

/** Rank of an id's own effort word for tie-breaking; a bare id (no word at all) ranks below every named word. */
function effortRank(effort: CursorEffort | undefined): number {
  return effort === undefined ? -1 : CURSOR_EFFORT_ORDER.indexOf(effort)
}

export interface CursorVariant {
  id: string
  base: string
  thinking: boolean
  /** The effort word literally in the id, if any -- not yet collapsed onto `none`. */
  effort: CursorEffort | undefined
  fast: boolean
}

/**
 * Strips `-fast`, then up to one effort word and one `-thinking` marker from
 * the right, in whichever order Cursor wrote them (`claude-opus-4-7-thinking-high`
 * and `claude-4.5-opus-high-thinking` both occur in the real catalog). What is
 * left is the base -- including a base that happens to end in a word this
 * grammar also uses for effort (`gpt-5.3-codex`), because that word is only
 * ever stripped once and only from the position a marker actually occupies.
 */
export function parseCursorModelId(id: string): CursorVariant {
  let tokens = id.split('-')
  let fast = false
  if (tokens.at(-1) === 'fast') {
    fast = true
    tokens = tokens.slice(0, -1)
  }
  let thinking = false
  let effort: CursorEffort | undefined
  for (let i = 0; i < 2 && tokens.length > 0; i += 1) {
    const last = tokens.at(-1) as string
    if (last === 'thinking' && !thinking) {
      thinking = true
      tokens = tokens.slice(0, -1)
    } else if (!thinking || effort === undefined) {
      if (isCursorEffort(last) && effort === undefined) {
        effort = last
        tokens = tokens.slice(0, -1)
      } else {
        break
      }
    } else {
      break
    }
  }
  return { id, base: tokens.join('-'), thinking, effort, fast }
}

/** This variant's position on the ladder: its own word when thinking, `medium` when thinking with no word, else `none` when the base has a thinking sibling at all, else its own word (`medium` when it has none either). */
function cursorLevel(variant: CursorVariant, baseHasThinking: boolean): CursorEffort {
  if (variant.thinking) {
    return variant.effort ?? 'medium'
  }
  return baseHasThinking ? 'none' : (variant.effort ?? 'medium')
}

/** A variant's own effort word, never collapsed onto `none` -- what `thinking`-axis selection matches against, as opposed to `cursorLevel`'s collapsed ladder position. */
function naturalLevel(variant: CursorVariant): CursorEffort {
  return variant.effort ?? 'medium'
}

export interface CursorBaseGroup {
  base: string
  variants: CursorVariant[]
  /** `variant.id` -> its ladder position. */
  levelOf: ReadonlyMap<string, CursorEffort>
  /** Every distinct level this base offers, ladder order -- absent when the base has only one variant, i.e. nothing to select. */
  reasoning: CursorEffort[] | undefined
  /**
   * `true` when a plain and a `-thinking` sibling of this base share the same
   * effort word -- the collision `cursorLevel`'s collapse cannot express on
   * the ladder alone, and the caller's only way to reach both is the
   * `thinking` request field. `modelsMenu.ts` reports this as
   * `capabilities.thinking`.
   */
  hasThinkingAxis: boolean
}

/** Every Cursor model id, grouped by base and given its ladder position. */
export function groupCursorModels(ids: readonly string[]): Map<string, CursorBaseGroup> {
  const byBase = new Map<string, CursorVariant[]>()
  for (const id of ids) {
    const variant = parseCursorModelId(id)
    const existing = byBase.get(variant.base)
    if (existing === undefined) {
      byBase.set(variant.base, [variant])
    } else {
      existing.push(variant)
    }
  }
  const groups = new Map<string, CursorBaseGroup>()
  for (const [base, variants] of byBase) {
    const baseHasThinking = variants.some((v) => v.thinking)
    const levelOf = new Map(variants.map((v) => [v.id, cursorLevel(v, baseHasThinking)]))
    const distinct = [...new Set(levelOf.values())].sort(
      (a, b) => CURSOR_EFFORT_ORDER.indexOf(a) - CURSOR_EFFORT_ORDER.indexOf(b),
    )
    const thinkingLevels = new Set(variants.filter((v) => v.thinking).map(naturalLevel))
    const plainLevels = new Set(variants.filter((v) => !v.thinking).map(naturalLevel))
    const hasThinkingAxis = [...thinkingLevels].some((level) => plainLevels.has(level))
    groups.set(base, {
      base,
      variants,
      levelOf,
      reasoning: variants.length > 1 ? distinct : undefined,
      hasThinkingAxis,
    })
  }
  return groups
}

/** The plainest variant of a base: non-thinking, non-fast, lowest (or absent) effort word -- what a caller means by the bare base name, and the source of its display name. */
export function representativeVariant(variants: readonly CursorVariant[]): CursorVariant {
  return [...variants].sort((a, b) => {
    if (a.thinking !== b.thinking) {
      return a.thinking ? 1 : -1
    }
    if (a.fast !== b.fast) {
      return a.fast ? 1 : -1
    }
    return effortRank(a.effort) - effortRank(b.effort)
  })[0] as CursorVariant
}

const DISPLAY_STRIP_PHRASES = [
  'extra high',
  'fast',
  'thinking',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Drops a trailing reasoning/fast/thinking word or two-word phrase, repeatedly, from a variant's own display name -- so a base's display name reads clean even when it has no unsuffixed variant to borrow one from verbatim. */
function stripReasoningWords(name: string): string {
  let words = name.split(' ')
  outer: while (words.length > 0) {
    for (const phraseLen of [2, 1]) {
      if (words.length < phraseLen) {
        continue
      }
      const tail = words.slice(-phraseLen).join(' ').toLowerCase()
      if (DISPLAY_STRIP_PHRASES.includes(tail)) {
        words = words.slice(0, -phraseLen)
        continue outer
      }
    }
    break
  }
  const stripped = words.join(' ').trim()
  return stripped === '' ? name : stripped
}

/** A base's own display name: the representative variant's name verbatim when it is already the bare id, else that same name with its trailing reasoning/fast words dropped. */
export function cursorBaseDisplayName(
  variants: readonly CursorVariant[],
  displayNameOf: (id: string) => string | undefined,
  fallback: string,
): string {
  const rep = representativeVariant(variants)
  const raw = displayNameOf(rep.id) ?? fallback
  return stripReasoningWords(raw)
}

export interface CursorRequestHint {
  reasoningEffort?: string
  serviceTier?: string
  /**
   * Selects the `-thinking` sibling (`true`) or the plain one (`false`) on a
   * base where the two share an effort word -- absent (the default) keeps
   * the collapsed-ladder behaviour below, where only the lowest-effort
   * plain sibling stays reachable at its shared level. This is engined's
   * own request extension; Cursor's real API has no such field.
   */
  thinking?: boolean
}

/** Every variant at one `levelOf` value, nearest available substituted when the exact one has none. */
function nearestByLevel(
  variants: readonly CursorVariant[],
  levelOf: (v: CursorVariant) => CursorEffort,
  want: CursorEffort,
): CursorVariant[] {
  const exact = variants.filter((v) => levelOf(v) === want)
  if (exact.length > 0) {
    return exact
  }
  const wantIdx = CURSOR_EFFORT_ORDER.indexOf(want)
  const available = new Set(variants.map(levelOf))
  let nearest: CursorEffort | undefined
  let nearestDist = Number.POSITIVE_INFINITY
  for (const candidate of available) {
    const dist = Math.abs(CURSOR_EFFORT_ORDER.indexOf(candidate) - wantIdx)
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = candidate
    }
  }
  return nearest === undefined ? [] : variants.filter((v) => levelOf(v) === nearest)
}

/** The `fast`-preferring, lowest-effort-first pick among `candidates` -- the tie-break every resolution path shares once its level is decided. */
function pickVariant(
  candidates: readonly CursorVariant[],
  fast: boolean,
): CursorVariant | undefined {
  if (candidates.length === 0) {
    return undefined
  }
  const fastMatches = candidates.filter((v) => v.fast === fast)
  const pool = fastMatches.length > 0 ? fastMatches : candidates
  return [...pool].sort((a, b) => effortRank(a.effort) - effortRank(b.effort))[0]
}

/** `hint.thinking`'s own resolution: matched against each variant's own effort word, never the collapsed ladder -- the one path that can tell a plain and a `-thinking` sibling apart at the same word. */
function resolveWithinThinkingAxis(
  bucket: readonly CursorVariant[],
  reasoningEffort: string | undefined,
  fast: boolean,
): CursorVariant | undefined {
  let level: CursorEffort
  if (reasoningEffort !== undefined && isCursorEffort(reasoningEffort)) {
    level = reasoningEffort
  } else {
    const bare = bucket.find((v) => v.effort === undefined)
    level = bare === undefined ? 'medium' : naturalLevel(bare)
  }
  return pickVariant(nearestByLevel(bucket, naturalLevel, level), fast)
}

/**
 * The one variant a `reasoning_effort`/`service_tier`/`thinking` request
 * resolves to. Absent `reasoningEffort` uses the base's own unsuffixed
 * variant when it has one, else `medium`. When several variants share a
 * level (the non-thinking collapse above), the lowest-effort one is
 * canonical -- deterministic, and the same rule `cursorBaseDisplayName` uses
 * to pick a representative.
 *
 * `hint.thinking`, when given, resolves within that one axis by each
 * variant's own effort word instead: this is what reaches a plain sibling
 * whose word a `-thinking` sibling also carries, which the collapsed ladder
 * alone can address only one of. A base with no sibling on the requested
 * axis falls through to the ordinary collapsed-ladder pick, same as
 * `thinking` being absent.
 */
export function resolveCursorVariant(
  group: CursorBaseGroup,
  hint: CursorRequestHint,
): CursorVariant | undefined {
  const fast = hint.serviceTier === 'priority'
  if (hint.thinking !== undefined) {
    const bucket = group.variants.filter((v) => v.thinking === hint.thinking)
    if (bucket.length > 0) {
      return resolveWithinThinkingAxis(bucket, hint.reasoningEffort, fast)
    }
  }
  let level: CursorEffort
  if (hint.reasoningEffort !== undefined && isCursorEffort(hint.reasoningEffort)) {
    level = hint.reasoningEffort
  } else {
    const bare = group.variants.find((v) => !v.thinking && v.effort === undefined)
    level = bare === undefined ? 'medium' : (group.levelOf.get(bare.id) as CursorEffort)
  }
  const candidates = nearestByLevel(
    group.variants,
    (v) => group.levelOf.get(v.id) as CursorEffort,
    level,
  )
  return pickVariant(candidates, fast)
}
