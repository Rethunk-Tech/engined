/**
 * The shapes every module shares, plus the few pure helpers that read them
 * (`probeSaysReady`). Depends on nothing but `http.ts`'s status names, so
 * config parse, spec loading, lifecycle and the door can be written against
 * one another without importing each other's implementations.
 */

import { STATUS_NOT_FOUND } from './http.ts'

/** Occupancy is one resident GGUF per role, so the set is closed. */
export type Role = 'chat' | 'vision' | 'embedding' | 'rerank'

/**
 * What a vision route's model actually does with an image, which `role` does
 * not say: `describe` reads a scene back in prose, `read` recognises the
 * characters printed in it. Both take an image and answer in text, so nothing
 * else on a route or its capabilities tells them apart -- and asking a reader
 * to describe a scene gets degenerate output, measured against PaddleOCR-VL.
 *
 * Required on a `vision` route and a parse error on any other. Not defaulted:
 * the default was "describe", and it was the wrong answer for half the vision
 * routes on this box -- a reader sent the describe check fails it while
 * working correctly, and nothing in that failure says the config is at fault.
 */
export type VisionKind = 'describe' | 'read'

/**
 * Where an upstream's bytes travel, ordered least to most exposed. Lives on
 * `Upstream` now, not on an engine -- an engine has no address of its own
 * to leak from, only the upstream it is paired with does. An ambient route
 * (no upstream at all) is `"remote"`: the CLI's own login leaves the box the
 * same as any other network call.
 */
export type Egress = 'none' | 'lan' | 'remote'

/** The only legal ordering on `Egress`. Index into this, never compare the strings themselves. */
export const EGRESS_RANK: Record<Egress, number> = { none: 0, lan: 1, remote: 2 }

/**
 * The ONLY membership test on `Egress`, keyed off `EGRESS_RANK` itself so a
 * fourth member is admitted by every parser the moment the table names it.
 * A hand-spelled chain of `!==` comparisons anywhere else typechecks and
 * lints clean while refusing a value this type declares legal.
 *
 * `Object.hasOwn`, never `in`: every object answers `in` for `toString`.
 */
export function isEgress(value: unknown): value is Egress {
  return typeof value === 'string' && Object.hasOwn(EGRESS_RANK, value)
}

/**
 * The ONLY legal comparison on `Egress`. Bare `<`/`<=` is banned: alphabetically
 * `"lan" < "none" < "remote"`, so the natural spelling admits a `lan` hop under a
 * `none` ceiling -- it typechecks, lints clean, and is wrong on the one boundary
 * that is a safety property.
 */
export function withinCeiling(value: Egress, ceiling: Egress | undefined): boolean {
  if (ceiling === undefined) {
    return true
  }
  return EGRESS_RANK[value] <= EGRESS_RANK[ceiling]
}

export type EngineKind = 'openai-http' | 'agentic-cli' | 'tts' | 'stt' | 'comfy'

/** The two request/response shapes an upstream can speak. An agent CLI speaks one; pairing it with the other is a parse error. */
export type Wire = 'openai' | 'anthropic'

/** How an engine gets an upstream when a route names none: itself (`self`), the ambient CLI login (`optional`), or its one declared upstream (`required`). */
export type UpstreamTrait = 'self' | 'optional' | 'required'

/** Whether a route field is mandatory, forbidden, or takes either -- the split predicate's answer once `kind` is known. */
export type Disposition = 'required' | 'forbidden' | 'allowed'

/** `filename`/`role`/`args`/`translate`/`fim` dispositions for a route on a given engine kind, checked at registry construction once `kind` is known. */
interface RouteFieldRules {
  filename: Disposition
  role: Disposition
  args: Disposition
  /** Only an `stt` route can mean anything by it: every other kind would carry a key nothing reads. */
  translate: Disposition
  /** Only a local llama route speaks `/infill`; every other kind would carry a key nothing reads. */
  fim: Disposition
}

/**
 * One table, whose value says what each kind is. Typed as a complete record
 * over `EngineKind`, so adding or removing a kind fails to compile here until
 * this file gives the new one an explicit answer -- which is the whole point:
 * an inline `kind === "a" || kind === "b"` elsewhere silently omits it.
 */
export const KIND_TRAITS: Record<
  EngineKind,
  { container: boolean; upstream: UpstreamTrait; localFile: RouteFieldRules }
> = {
  'openai-http': {
    container: true,
    // A spec-less openai-http engine (openrouter) is a pure proxy: it must
    // name the one upstream it proxies to, there being no "self" to default to.
    upstream: 'required',
    localFile: {
      filename: 'required',
      role: 'required',
      args: 'allowed',
      translate: 'forbidden',
      fim: 'allowed',
    },
  },
  // The only kind that runs no container at all.
  'agentic-cli': {
    container: false,
    upstream: 'optional',
    localFile: {
      filename: 'forbidden',
      role: 'forbidden',
      args: 'forbidden',
      translate: 'forbidden',
      fim: 'forbidden',
    },
  },
  tts: {
    container: true,
    upstream: 'self',
    localFile: {
      filename: 'forbidden',
      role: 'forbidden',
      args: 'forbidden',
      translate: 'forbidden',
      fim: 'forbidden',
    },
  },
  stt: {
    container: true,
    upstream: 'self',
    localFile: {
      filename: 'required',
      role: 'forbidden',
      args: 'allowed',
      translate: 'allowed',
      fim: 'forbidden',
    },
  },
  comfy: {
    container: true,
    // comfy runs here or on some peer's `local`, never against a foreign provider.
    upstream: 'self',
    localFile: {
      filename: 'forbidden',
      role: 'forbidden',
      args: 'forbidden',
      translate: 'forbidden',
      fim: 'forbidden',
    },
  },
}

/**
 * There is no `idle`: idle-stop leaves an engine `installed` with nothing
 * running, which reads identically to one that has never started because
 * operationally it is.
 */
export type EngineState = 'unavailable' | 'installed' | 'warming' | 'running'

/** Names a keyring pair and the header to project it into. Never a value. */
export interface SecretRef {
  service: string
  username: string
  header: string
  /** The auth scheme prefix a provider expects before the credential, e.g. "Bearer". Absent means the header carries the raw value. */
  scheme?: string
}

/**
 * Fields shared by a `[[model]]` capability row and a `[[route]]`'s own
 * overrides of it -- a route may state a capability a provider tier
 * genuinely differs on without needing a whole second `[[model]]` row.
 */
export interface ModelCapabilities {
  input?: string[]
  output?: string[]
  context_in?: number
  context_out?: number
  reasoning?: string[]
  /**
   * `true` only for a Cursor base where a plain and a `-thinking` sibling
   * share the same effort word (`cursorModels.ts`'s own `hasThinkingAxis`):
   * the caller's `thinking: boolean` request field is what reaches the one
   * `reasoning` alone leaves unaddressed at that word. Absent everywhere
   * else, including a Cursor base with no such collision.
   */
  thinking?: boolean
}

/**
 * A name and what it can do, unrelated to any engine or upstream -- a model
 * is a name with capabilities; which engines and upstreams can reach it is
 * entirely `[[route]]`'s business. Optional: a route may name a model with
 * no row here at all, and `/openai/v1/models` reports empty capabilities for it.
 */
export interface ModelEntry extends ModelCapabilities {
  id: string
}

/** Names a keyring pair, an address and the wire it speaks -- *where* the bytes for a route come from, never *how* they are produced. */
export interface Upstream {
  id: string
  base_url?: string
  secret?: SecretRef
  egress: Egress
  wire?: Wire
  disabled?: boolean
  /**
   * How long a cached `/models` list remains usable. Required when a wildcard
   * route names this upstream: a failed fetch otherwise has no age at which
   * to drop the file.
   */
  inventory_max_age_seconds?: number
  /**
   * How often to re-fetch the catalog. Absent means 3600 seconds. Must be
   * less than max age when both are set.
   */
  inventory_refresh_seconds?: number
  /**
   * Extra headers sent on every remote hop. Keys that would override the auth
   * header `secret` names, and `Host`, are refused at parse (case-insensitive).
   */
  headers?: Record<string, string>
}

/**
 * One engine paired with one upstream, resolved out of a `[[route]]` table
 * plus whatever `[[model]]` row (if any) its `model` names. `engine`,
 * `upstream` and `model` are three independent things related many-to-many:
 * none owns another, and a route is the only place that says which pairing
 * actually exists.
 */
export interface ResolvedRoute extends ModelCapabilities {
  engine: string
  /** Absent on a MODELLESS route (comfy, and every media engine): this engine runs on this upstream and nothing more. */
  model?: string
  /** The id the upstream knows this model by, when that differs from the name it is addressed by. Sent on the wire in place of `model` whenever present. */
  wire_model?: string
  /**
   * Presentation only: a human label a client may show. Never an address —
   * `@/engine/model` is still how the door is called, and this field is not
   * consulted by dispatch.
   */
  display_name?: string
  /** `null` === ambient: no upstream, the CLI's own login. Egress is `"remote"`. */
  upstream: string | null
  /** Absent by construction whenever `upstream` is not `"local"`: a route proxied elsewhere has no local file to describe. */
  filename?: string
  role?: Role
  /** See `VisionKind`. Absent on any route that is not `role = "vision"`. */
  vision?: VisionKind
  /**
   * This STT model's weights are multilingual, so it can be asked to render
   * speech in another language as English -- what `/openai/v1/audio/translations`
   * is. Declared per route rather than inferred, because the model file is the
   * whole difference and nothing about a request reveals it: an English-only
   * model handed the translate flag does not fail, it transcribes the audio
   * as though the flag were absent and returns a confident wrong answer.
   *
   * A route that does not declare it does not serve that verb (`routeServes`),
   * so the refusal is a 400 naming the address rather than a silent no-op.
   */
  translate?: boolean
  /**
   * This route answers `/openai/v1/completions` too, mapped onto llama-
   * server's `/infill` (`completions.ts`) -- fill-in-the-middle, not every
   * resident GGUF's strength, and not implied by `role = "chat"`. A route
   * that does not declare it does not serve that verb (`routeServes`), so an
   * unopted route's completion request gets the door's normal 4xx naming the
   * address rather than a silent pass-through to a model nobody vetted for it.
   */
  fim?: boolean
  /**
   * Chat-route opt-in: the address of a `role = "vision"` route
   * (`src/visionBridge.ts`) this door sends an image to first, captioning it
   * and splicing `[Image N: <caption>]` text into the request before
   * dispatching to this route. Fatal at parse on anything but a chat route --
   * a vision route already has its own image input, and captioning it through
   * a second vision route would be double work with nowhere to fall back when
   * the bridge itself has none. Absent means this route has no image path at
   * all; a caller sending one is refused the way any unsupported modality is.
   */
  vision_bridge?: string
  /**
   * Load this GGUF when its engine starts, and reload it whenever its role
   * falls idle again — warmth guaranteed against idleness, never against
   * contention. Occupancy is still one model per role, so a request for a
   * different model on the same role wins the swap exactly as it does now;
   * this only decides what the role returns to once nothing is waiting.
   *
   * It necessarily pins the container up too: idle-stop stops the whole
   * container, so an engine with one of these never idle-stops and holds its
   * share of the pool until engined is reloaded. That is the cost, and it is
   * why this is opt-in per route rather than a default.
   */
  keep_resident?: boolean
  /** Overrides the engine spec's `streaming` for this one route: a provider tier that cannot chunk what its siblings can. Absent means the engine's own answer. */
  streaming?: boolean
  /**
   * The token count at or above which `LlamaRouter`'s own slot placement
   * (`llamaSlots.ts`) calls a prompt "long" and reserves it one of this
   * route's `ceil(parallel / 2)` long slots, rather than the LRU-picked
   * short one a small side request would otherwise overwrite. Engined-only:
   * never rendered into the presets INI, unlike `args`. Meaningful only
   * where `args.parallel` merges to a positive integer `>= 2`; absent
   * elsewhere. `DEFAULT_SLOT_LONG_THRESHOLD` when the route leaves it unset.
   */
  slot_long_threshold?: number
  /** Rendered into this model's section of the presets INI, verbatim. */
  args: Record<string, unknown>
  /**
   * Configured but not served: this route, its engine, or its upstream
   * carries `disable = true`. Kept on the entry rather than dropped from
   * `Config` so a caller asking why a route is unreachable gets a real
   * answer.
   */
  disabled?: boolean
}

export interface EngineEntry {
  id: string
  /**
   * Configured but not served: this engine's own `[[engine]]` table carries
   * `disable = true`. Kept on the entry rather than filtered out of `Config`
   * so `GET /engined/v1/engines` can report it as off — which is the
   * difference an operator needs between "turned off here" and "gone from
   * the config".
   */
  disabled?: boolean
  /** Replaces a shipped spec wholesale, never field by field. */
  spec_dir?: string
  models_dir?: string
  models_max?: number
  idle_stop_seconds: number
  /**
   * How long a submission waits for this engine to be free before it is
   * refused. Only the comfy proxy holds submissions today: it keeps one prompt
   * in a container at a time, which is what makes an unscoped `/interrupt`
   * safe (see `src/comfyProxy.ts`). Not a render-length estimate -- it is the
   * ceiling that stops a wedged container parking every later submission
   * forever, so a render that legitimately runs longer is refused rather than
   * queued, and this is the key to raise when one does.
   */
  drain_timeout_seconds?: number
  ready_timeout_s: number
  agent_version?: string
  /** An engine has no address of its own; every dialect it speaks comes from `kind` or a real shipped spec. */
  kind?: EngineKind
  /** The engine's own process flags. A model's args win over the same key. */
  args: Record<string, unknown>
}

export interface Config {
  listen_port: number
  /** h2c listener for the Cursor turn stream; see `cursorAgent.ts`. */
  cursor_port: number
  chat_timeout_seconds: number
  agent_timeout_seconds: number
  engines: EngineEntry[]
  upstreams: Upstream[]
  /** The route table. A `[[model]]` row is not carried here: parse folds its capabilities into every route that names it, and that fold is the only form anything reads. */
  routes: ResolvedRoute[]
  /** Every hop is a fully-qualified `@/<engine>/<model>`. */
  chains: Record<string, string[]>
}

export interface Volume {
  name: string
  path: string
  /**
   * Mount `:ro`. The model store and the rendered presets INI are both inputs
   * the container reads once and must not be able to rewrite — llama-server
   * reading its own occupancy configuration from a file it could edit is the
   * case this exists to prevent.
   */
  read_only?: boolean
}

/** Declared so `installed` can be honest about what a pulled image still lacks. */
export interface Artifact {
  path: string
  /** The literal command that supplies it, surfaced verbatim in status. */
  obtain: string
}

/** A TCP connect is not readiness, so each spec names its own probe. */
export interface ReadyProbe {
  path: string
  /** The exact status meaning ready, when `accept` is absent. */
  status: number
  /** Defaults to GET. Some engines answer their dialect path only to POST. */
  method?: 'GET' | 'POST'
  /**
   * When set, any status in this inclusive range means ready — except 404,
   * which never does. An engine whose only route is an inference path answers
   * an empty probe payload with a 4xx, and that still proves the route exists,
   * whereas a 404 proves it does not.
   */
  accept?: { min: number; max: number }
}

/** Whether a probe response means the engine is ready to serve. */
export function probeSaysReady(probe: ReadyProbe, status: number): boolean {
  if (status === STATUS_NOT_FOUND) {
    return false
  }
  if (probe.accept === undefined) {
    return status === probe.status
  }
  return status >= probe.accept.min && status <= probe.accept.max
}
