import type { ModelCapabilities, Role, VisionKind } from './types.ts'

/**
 * The door's OpenAI-surface paths, spelled once. A `serves` list, a dispatch
 * check and a route table that spell one differently disagree silently.
 */
export const CONTENT_ENDPOINT_CHAT = '/openai/v1/chat/completions'
export const CONTENT_ENDPOINT_EMBEDDINGS = '/openai/v1/embeddings'
export const CONTENT_ENDPOINT_SPEECH = '/openai/v1/audio/speech'
export const CONTENT_ENDPOINT_TRANSCRIPTIONS = '/openai/v1/audio/transcriptions'
export const CONTENT_ENDPOINT_TRANSLATIONS = '/openai/v1/audio/translations'
export const CONTENT_ENDPOINT_IMAGES = '/openai/v1/images/generations'
export const CONTENT_ENDPOINT_IMAGE_EDITS = '/openai/v1/images/edits'
export const CONTENT_ENDPOINT_RERANK = '/openai/v1/rerank'
/** The legacy OpenAI completions shape, mapped onto llama-server's `/infill` — see `completions.ts`. Never claimed by a role: it answers alongside chat on the same route, opted into per route by `fim`, not exclusive to it. */
export const CONTENT_ENDPOINT_COMPLETIONS = '/openai/v1/completions'

/**
 * The one door path a role answers to the exclusion of every other role.
 * `embedding` and `rerank` are each a dedicated model kind serving a verb
 * nothing else serves: a chat GGUF asked to rerank has no such endpoint, and
 * a reranker asked to chat produces a score, not a turn.
 *
 * A role absent from this table (`chat`, `vision`) answers every path its
 * engine serves that is not claimed here. That is what keeps a fourth role
 * from silently inheriting both verbs: adding it means deciding whether it
 * owns a path, in this one table.
 */
const ROLE_ENDPOINT: Partial<Record<Role, string>> = {
  embedding: CONTENT_ENDPOINT_EMBEDDINGS,
  rerank: CONTENT_ENDPOINT_RERANK,
}

/** Read off `ROLE_ENDPOINT` itself, never spelled a second time -- a hand-kept copy admits a claimed path to every unclaimed role the moment the two drift. */
const CLAIMED_ENDPOINTS: ReadonlySet<string> = new Set(Object.values(ROLE_ENDPOINT))

/** The subset of a route this answer depends on -- `EngineCapability` and `ResolvedRoute` both satisfy it, so neither has to be reshaped to ask the question. */
export interface RouteServesFields {
  role?: Role
  translate?: boolean
  fim?: boolean
}

/**
 * The door paths one route answers, which its engine's own `serves` cannot
 * say on its own: a role that claims a path answers only that path, a role
 * that claims none answers everything no other role claims, and a route with
 * no role (agentic, proxied, media) whatever its engine serves.
 *
 * Translations is the one path a role cannot decide, because it is the model
 * file and not the role that separates a whisper route that can translate
 * from one that cannot. Every stt route on an engine whose spec serves that
 * path would otherwise inherit it, English-only weights and all.
 *
 * Completions is the same shape of question for a different reason: every
 * local llama route's engine spec lists it (llama-server's `/infill` answers
 * for any resident GGUF), but not every GGUF is worth pointing a FIM client
 * at, so a route opts in with `fim` rather than inheriting it just for being
 * on the engine.
 */
export function routeServes(route: RouteServesFields, engineServes: readonly string[]): string[] {
  const { role, translate, fim } = route
  const byRole =
    role === undefined
      ? [...engineServes]
      : engineServes.filter((path) => {
          const claimed = ROLE_ENDPOINT[role]
          return claimed === undefined ? !CLAIMED_ENDPOINTS.has(path) : path === claimed
        })
  const withTranslate =
    translate === true ? byRole : byRole.filter((path) => path !== CONTENT_ENDPOINT_TRANSLATIONS)
  return fim === true
    ? withTranslate
    : withTranslate.filter((path) => path !== CONTENT_ENDPOINT_COMPLETIONS)
}

/**
 * One route's own resolved capability fields, alongside the model they
 * describe -- absent `model` reports the fields a modelless route declared
 * directly on itself. An engine with several model-bearing routes reports
 * one of these per route rather than merging them into a single answer: two
 * routes on the same engine may genuinely differ (different context windows
 * on different upstream tiers, for one), and merging would silently pick a
 * winner the way `EnginesResponse` never has elsewhere.
 */
export interface EngineCapability extends ModelCapabilities {
  model?: string
  /** The door paths this one route answers -- see `routeServes`. */
  serves: string[]
  /** This route's inference role -- the same field, for the same reason, as `ModelRow.role`. */
  role?: Role
  /** See `VisionKind`. Absent unless this route is `role = "vision"`. */
  vision?: VisionKind
  /** See `ResolvedRoute.translate`. Absent on every route that did not declare it. */
  translate?: boolean
  /** See `ResolvedRoute.fim`. Absent on every route that did not declare it. */
  fim?: boolean
}
