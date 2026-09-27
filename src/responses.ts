/**
 * What the door answers with: the engine, model and start rows a caller reads,
 * and the contract number that says when one of their meanings changed.
 */

import type {
  Egress,
  EngineCapability,
  EngineKind,
  EngineState,
  ModelCapabilities,
  Role,
  VisionKind,
} from './types.ts'

/**
 * What one role is doing right now: the requests holding its lease, and the
 * ones queued behind them. Reported only for a role that has either, so an
 * idle engine carries none of this rather than a row of zeroes.
 */
export interface RoleContention {
  role: Role
  active: number
  waiting: number
}

/**
 * No `private_url`, on purpose: every control this project has -- call
 * recording, egress ceilings, and later the budgets that decide whose money
 * pays -- lives at the door, and a consumer holding a raw container address
 * routes around all of it. The value stays an internal runtime one --
 * `docker.ts`'s own `RuntimeStatus`, read straight off `DockerLifecycle` by
 * whichever door verb still needs it -- it simply never reaches the wire.
 */
export interface EngineStatus {
  id: string
  kind: EngineKind
  serves: string[]
  state: EngineState
  /**
   * This engine's own `[[engine]]` table carries `disable = true`. Always
   * reported with `state: "unavailable"` — nothing was probed to establish
   * that, so the two are not independent readings — and `fix` names the
   * config edit that undoes it. Absent on every engine that is actually
   * served.
   */
  disabled?: boolean
  /** The literal `docker pull` / `docker build` / `secret-tool store` that fixes it. */
  fix?: string
  /**
   * Per-role contention, for the llama engines that have roles at all. Absent
   * when nothing is queued or running, and absent entirely on a kind that has
   * no leases -- the distinction a caller needs is "waiting behind someone"
   * versus "loading", which `state` alone cannot answer.
   */
  roles?: RoleContention[]
  /**
   * Whether `"stream": true` is servable by this engine, on whichever route
   * it serves that admits streaming at all. Every kind declares it through
   * `spec.ts`'s `streaming` key, so a real boolean is the honest answer
   * everywhere: `false` means "this engine does not
   * stream", not "unknown". Without it a consumer's only way to learn that an
   * engine cannot chunk is a 502 per request, or a hardcoded engine list that
   * goes stale the moment engined gains an engine.
   */
  streaming: boolean
  /**
   * This container is running under a config generation `reload` has since
   * replaced, and will keep its old shape until it next starts. Absent on
   * anything not running, and on a running engine whose shape still matches.
   *
   * The value is the literal call that resolves it. Nothing acts on this by
   * itself: restarting an engine on an operator's behalf would reload
   * whatever it had resident -- up to ~30 GiB for llama -- because of an edit
   * that may not even have named it. Reporting it is what turns a silent
   * "my config change did nothing" into an answer the operator surface gives.
   */
  superseded?: string
  last_error?: string
  /**
   * Requests holding this engine open right now. The audio engines serialize
   * every request on one process-wide lock inside the container, so a second
   * caller waits with nothing else reporting that it is waiting; this is how
   * concurrent demand on them is visible at all.
   */
  active_leases?: number
  /**
   * What this engine's own model-bearing routes can be asked for, one entry
   * per non-disabled route -- the config surface `[[route]]`/`[[model]]`
   * capability fields exist to answer, so a caller learns it from this
   * listing rather than needing a second source. Absent when the engine has
   * no model-bearing routes at all (comfy, every modelless media engine).
   */
  capabilities?: EngineCapability[]
}

export interface EnginesResponse {
  /** Bumped when a consumer-visible shape changes. */
  contract: number
  /** The source revision, written into the bundle by the install script. */
  commit: string
  engines: EngineStatus[]
  /**
   * The parse error from the most recent failed reload, if one is outstanding.
   * A reload that cannot parse keeps the previous config serving, so this is
   * the only place an operator learns the edit did not take.
   */
  config_error?: string
}

/**
 * One `GET /openai/v1/models` row: an address with its own capabilities,
 * never a bare id. `id` is the addressable `@/...` string a caller can put
 * straight into `model` -- the two-segment form when it is unambiguous on
 * its own, the three-segment form when a sibling route shares its
 * `(engine, model)` pair on a different upstream. A chain row omits
 * `engine`/`upstream`/`model`/`egress`: no single one answers for every hop,
 * so `streaming` and `capabilities` are its first hop's instead -- that is
 * the hop a request starts on -- except `capabilities.context_in`/
 * `context_out`, which are the minimum reported by any hop, since a fallback
 * onto a smaller hop must not overflow a window sized against the first.
 */
export interface ModelRow {
  id: string
  engine?: string
  upstream?: string
  model?: string
  /**
   * Presentation only. Present when the route declared one; omitted otherwise
   * and on every chain row. Never an address.
   */
  display_name?: string
  egress?: Egress
  streaming: boolean
  /**
   * Whether a request that actually demands a tool call -- a non-empty
   * `tools`, a `tool_choice` naming one, a `response_format` that is not
   * plain text -- is forwarded rather than refused here. An agent CLI takes
   * a prompt string and prints answer text, so it has no channel for either
   * half of a tool loop and the door refuses such a request outright; an
   * embeddings row is `false` for the same reason from the other side, with
   * no tool-call channel to forward one down. A chain row is `true` only
   * when EVERY hop forwards them, since a fallback onto a hop that cannot is
   * exactly what turns a tool call into prose. `false` never means the
   * upstream model is bad at tool calling; that is the upstream's own answer
   * to give, and it says nothing about the values that demand nothing (an
   * empty `tools`, `tool_choice: "none"`), which every row honours.
   */
  tools: boolean
  serves: string[]
  /**
   * The route's inference role, and the only field that says an address does
   * vision: `serves` separates an embedding route from everything else and
   * nothing more, because chat and vision answer the same door path. Absent
   * on a route declaring no role, and on a chain row, which names no single
   * route to take one from.
   */
  role?: Role
  /**
   * See `VisionKind`. A vision address that reads characters and one that
   * describes a scene are the same `role` and the same `serves`, so this is
   * what a consumer picks on -- and what decides which ground-truth check
   * `src/probe.ts` sends it.
   */
  vision?: VisionKind
  /**
   * See `ResolvedRoute.translate`: this STT model's weights are multilingual,
   * so it may be asked to render speech as English. Reported because `serves`
   * says the address answers the translations path but not that the route was
   * the one allowed to -- and `src/probe.ts` reads it to know which
   * transcription routes must REFUSE that verb. Absent unless declared.
   */
  translate?: boolean
  /**
   * The `role = "vision"` address this route bridges an image through before
   * answering (`src/visionBridge.ts`). Present only on a route that declared
   * `vision_bridge`; `capabilities.input` on such a row includes `"image"`
   * alongside this field, so a consumer can show an image-attach affordance
   * for a route that has no image input of its own.
   */
  vision_bridge?: string
  /**
   * Whether this address can answer at all. On a chain that is the first hop
   * that can: a chain advances past a hop it cannot reach, so one reachable
   * hop anywhere makes the chain `installed` even when earlier ones are not.
   * `unavailable_hops` is what tells those two apart.
   */
  state: EngineState
  /**
   * A chain's hops, in order, and the only thing on the row that says where
   * it goes: a chain is not any one engine's route, so `engine`, `upstream`,
   * `model` and `egress` are all absent from it. Present on every chain row
   * and absent on every route row, which is what tells the two apart -- and
   * what lets a caller see that a chain and a route it wraps are the same
   * destination rather than two models. A healthy chain reports nothing at
   * all about itself without this, since `unavailable_hops` is absent
   * exactly when nothing is broken.
   */
  hops?: string[]
  /**
   * The hops of a chain that cannot answer -- an engine that is not
   * installed, or an upstream whose address or secret does not resolve.
   * A subset of `hops`. Absent when every hop can answer, and on every
   * non-chain row. A chain whose hops are ALL listed here is one nothing can
   * answer, and its `state` says `unavailable` to match.
   */
  unavailable_hops?: string[]
  /**
   * `capabilities.thinking: true` is Cursor-specific: it marks a base where a
   * plain and a `-thinking` sibling share one effort word, so `reasoning`'s
   * collapsed ladder alone reaches only the lower-effort one at that word.
   * A caller who needs the other sends `thinking: true`/`false` on the
   * request (`cursorModels.ts`'s `resolveCursorVariant`) rather than relying
   * on the effort word alone. Absent on every non-Cursor row and on a
   * Cursor base with no such collision.
   */
  capabilities: ModelCapabilities
}

export interface ModelsResponse {
  object: 'list'
  data: ModelRow[]
}

/**
 * One `POST /engined/v1/start` row: the route this call acted on and what
 * became of it. No `url` — an engine sits behind the door, and where its
 * container happens to listen is the door's own business, never the
 * caller's. Byte-identical to a peer-forwarded answer, so nothing about this
 * shape changes when a later delivery has a peer answer instead of this box.
 */
export interface StartRow {
  address: string
  engine: string
  upstream: string | null
  state: EngineState
  /** True when this call launched the engine; false when it was already running. */
  started: boolean
  fix?: string
}

export interface StartResponse {
  object: 'list'
  data: StartRow[]
}

/** Bumped when a field is removed, a state renamed, or a route's meaning altered. */
export const CONTRACT = 6
