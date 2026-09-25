/**
 * The shapes every module shares, plus the few pure helpers that read them
 * (`probeSaysReady`, `argvFromArgs`, the agentic-floor assertions). Depends on
 * nothing but `http.ts`'s status names, so config parse, spec loading,
 * lifecycle and the door can be written against one another without importing
 * each other's implementations.
 */

import { ParseError } from './errors/parse.ts'
import { STATUS_NOT_FOUND } from './http.ts'

/** Occupancy is one resident GGUF per role, so the set is closed. */
export type Role = 'chat' | 'vision' | 'embedding' | 'rerank'

/**
 * `[[route]] model` sentinel that expands from a remote provider catalog.
 * It is never a served address: `@/engine/*` is a 400, not a dispatchable id.
 */
export const WILDCARD_MODEL = '*'

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

/** `filename`/`role`/`args`/`translate` dispositions for a route on a given engine kind, checked at registry construction once `kind` is known. */
interface RouteFieldRules {
  filename: Disposition
  role: Disposition
  args: Disposition
  /** Only an `stt` route can mean anything by it: every other kind would carry a key nothing reads. */
  translate: Disposition
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
    localFile: { filename: 'required', role: 'required', args: 'allowed', translate: 'forbidden' },
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
    },
  },
  stt: {
    container: true,
    upstream: 'self',
    localFile: { filename: 'required', role: 'forbidden', args: 'allowed', translate: 'allowed' },
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
}

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
 */
export function routeServes(route: RouteServesFields, engineServes: readonly string[]): string[] {
  const { role, translate } = route
  const byRole =
    role === undefined
      ? [...engineServes]
      : engineServes.filter((path) => {
          const claimed = ROLE_ENDPOINT[role]
          return claimed === undefined ? !CLAIMED_ENDPOINTS.has(path) : path === claimed
        })
  return translate === true
    ? byRole
    : byRole.filter((path) => path !== CONTENT_ENDPOINT_TRANSLATIONS)
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
  idle_stop_seconds?: number
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
  ready_timeout_s?: number
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

/**
 * The qualified address form an operator or caller writes: `@/model` (one
 * segment), `@/engine/model` (two -- or `@/engine/upstream` for a modelless
 * engine), or `@/engine/upstream/model` (three, fully explicit). One regex
 * with two nested optional groups, so a three-segment match is only ever
 * reached through a present second segment -- never a shape a second regex
 * has to re-derive. Segment count alone decides the reading; that is
 * `qualifiedSegments`'s job, not this pattern's.
 */
const QUALIFIED_MODEL_RE = /^@\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/

/** `QUALIFIED_MODEL_RE`'s match, as the one, two or three non-empty segments it captured. `undefined` when `model` is not a qualified `@/...` address at all. */
export function qualifiedSegments(model: string): string[] | undefined {
  const match: RegExpExecArray | null = QUALIFIED_MODEL_RE.exec(model)
  if (!match) {
    return undefined
  }
  return [match[1], match[2], match[3]].filter((seg): seg is string => seg !== undefined)
}

/**
 * A route on one engine, by model id -- and, when `upstream` is given, on
 * that one upstream specifically. A modelless route (`model` absent) never
 * matches: `model` here is always a real string, and `undefined === model`
 * is never true.
 */
function findModelOnEngine<T extends { engine: string; model?: string; upstream: string | null }>(
  routes: readonly T[],
  engineId: string,
  model: string,
  upstream?: string,
): T | undefined {
  return routes.find(
    (r) =>
      r.engine === engineId &&
      r.model === model &&
      (upstream === undefined || r.upstream === upstream),
  )
}

/**
 * The one route a resolved `@/engine/[upstream/]model` hop names. Two
 * segments default the upstream the way the dispatcher does -- ambient, then
 * this box's own `local` -- never whichever matching route was declared
 * first, which would run an ambient dispatch on a keyed upstream. A disabled
 * route is configured but not served, so it is never the resolved hop. A
 * lookup this cannot express -- a modelless route has no model segment to
 * match on -- excludes the same set itself rather than serving a wider one.
 */
export function routeForHop<
  T extends { engine: string; model?: string; upstream: string | null; disabled?: boolean },
>(routes: readonly T[], engineId: string, model: string, upstream?: string): T | undefined {
  const served = routes.filter((r) => r.disabled !== true)
  if (upstream !== undefined) {
    return findModelOnEngine(served, engineId, model, upstream)
  }
  const matches = served.filter((r) => r.engine === engineId && r.model === model)
  return matches.length === 1 ? matches[0] : pickDefaultUpstream(matches)
}

/** Among routes sharing one `(engine, model)`, the default upstream: ambient first, then this box's own `local`. Anything else is a real ambiguity the caller must break with the three-segment form. */
function pickDefaultUpstream<T extends { upstream: string | null }>(
  matches: readonly T[],
): T | undefined {
  return matches.find((r) => r.upstream === null) ?? matches.find((r) => r.upstream === 'local')
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

/**
 * Prepended by engined in code on every agentic launch and removable by no
 * config entry or `spec_dir` override. Asserting `--safe-mode` alone is not
 * enough: neither the tool allowlist nor the MCP closure is sufficient by
 * itself, so all three are the floor.
 */
export const AGENTIC_FLOOR = [
  '--safe-mode',
  '--tools',
  'Read,Grep,Glob',
  '--strict-mcp-config',
] as const

/**
 * Not part of any safety floor -- needed only so stdout is the JSON the parser
 * expects. Unconditional in code on every call, the same as a floor: never
 * write `output-format` into a `[engine.args]` table.
 */
export const CLAUDE_OUTPUT_FORMAT = ['--output-format', 'json'] as const

/**
 * Names the empty config `--strict-mcp-config` holds claude to. Declared as
 * prepended so no config can name a second file and open the MCP door.
 */
export const CLAUDE_MCP_CONFIG_FLAG = ['--mcp-config'] as const

/** The streamed form: `stream-json` needs `--verbose` in print mode, and partial messages are what make it a stream of deltas rather than one chunk per turn. */
export const CLAUDE_STREAM_FORMAT = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
] as const

/**
 * `--output-format text` emits an empty stream on a refused write -- the tool
 * calls and the refusal itself are visible only in the `stream-json` event
 * log, so this is part of the floor's own evidence, not a preference.
 */
export const CURSOR_OUTPUT_FORMAT = ['--output-format', 'stream-json'] as const

/**
 * cursor's floor: a mode, not a tool allowlist. Measured (docs/security-model.md)
 * against 2026.08.28-50f0823: under `--mode plan` it read files and ran
 * read-only shell commands, but a write instruction produced no file and the
 * text "Plan mode blocks file writes", reaching for its plan tool instead --
 * unmoved by a permissive `.cursor/cli-config.json` planted in the workdir and
 * its parent. `--trust` carries no write capability of its own; without it a
 * fresh workdir's workspace-trust prompt refuses the launch outright before
 * plan mode is ever reached.
 */
export const CURSOR_FLOOR = ['--mode', 'plan', '--trust'] as const

/**
 * Everything engined itself prepends to an agentic launch, keyed by the agent
 * it is prepended for -- the read-only floor and the output format alike,
 * since a config that re-supplies either one reaches the child. Kept per
 * agent rather than merged into one array because where the floor comes from
 * is per-agent: claude's is argv, cursor's is a mode, and opencode's is the
 * bwrap mount table, which has no argv to name here at all.
 *
 * `agents.ts` composes each launch from exactly these.
 */
export const AGENT_PREPENDED_ARGV: Record<string, readonly (readonly string[])[]> = {
  claude: [CLAUDE_OUTPUT_FORMAT, CLAUDE_STREAM_FORMAT, AGENTIC_FLOOR, CLAUDE_MCP_CONFIG_FLAG],
  cursor: [CURSOR_OUTPUT_FORMAT, CURSOR_FLOOR],
}

/** Each dissolves the guarantee. Fatal at parse wherever they appear. */
export const FORBIDDEN_AGENTIC_FLAGS = [
  // opencode's own dangerous flag: "auto-approve permissions that are not
  // explicitly denied". It cannot reach the sandbox floor, but it hands an
  // agent shell and network without asking, so no agentic engine gets it.
  '--auto',
  '--add-dir',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  // cursor's own two spellings of "run everything without asking" --
  // `--yolo` is documented as a bare alias for `--force`. Whether either
  // actually overrides `--mode plan` was never tested; the assertion costs
  // nothing either way, and cursor exposes more ways to say yes than claude
  // does.
  '--force',
  '--yolo',
  // cursor's own escape hatch from its sandbox. Only `disabled` dissolves
  // anything, but the config sites validate a KEY -- `argKeysAsFlags` renders
  // no values at all -- so a value-conditional refusal is a distinction the
  // caller structurally cannot make, and the one written here silently let
  // every value through. The key is the whole danger: engined decides this
  // posture, not a config.
  '--sandbox',
] as const

/**
 * Derived from `AGENT_PREPENDED_ARGV` itself rather than hand-copied: a config
 * `[engine.args]` key that renders to `--tools` (or any other prepended flag)
 * appends a SECOND copy after engined's own, and last-wins argument parsing
 * means whatever the config supplied is what the child actually gets — the
 * flag was never really prepended, just overwritten. Deriving means any flag
 * later added to any agent's own constants is automatically unbeatable too,
 * with nothing new to remember to blacklist.
 *
 * The blast radius differs per agent, which is why the format flags are in
 * here beside the floor: re-supplying `--output-format` to cursor silences the
 * `stream-json` event log that IS that floor's evidence (docs/security-model.md),
 * while on claude it only fails the envelope parser closed.
 *
 * Flattened across agents at the last step because the sites that ask cannot
 * know which agent they are asking for: a config names an engine, and the
 * agent id arrives later, out of that engine's spec.
 */
const AGENT_PREPENDED_FLAG_NAMES = new Set<string>(
  Object.values(AGENT_PREPENDED_ARGV).flatMap((groups) =>
    groups.flatMap((tokens) => tokens.filter((token) => token.startsWith('--'))),
  ),
)

/** The two ways a bare flag name can dissolve the floor: it's outright forbidden, or it duplicates one engined already prepends. */
function assertNotForbiddenOrFloorDuplicate(bare: string, file: string): void {
  if ((FORBIDDEN_AGENTIC_FLAGS as readonly string[]).includes(bare)) {
    throw new ParseError(`${bare} dissolves the read-only floor`, file)
  }
  if (AGENT_PREPENDED_FLAG_NAMES.has(bare)) {
    throw new ParseError(
      `${bare} duplicates a flag engined prepends on every agentic launch; it cannot be overridden, only engined's own value would apply`,
      file,
    )
  }
}

/**
 * Every forbidden flag is forbidden by its name alone, and so is any flag
 * that duplicates one the floor itself sets. No value is consulted: the
 * config call sites hand this `argKeysAsFlags`, keys with no values at all,
 * so a rule that read `argv[i + 1]` would be reading the next KEY there and
 * would wave the flag through. A flag whose danger depends on its value is a
 * flag this function cannot honestly judge, so none is admitted.
 *
 * Throws `ParseError` naming the flag and the file.
 */
export function assertNoForbiddenFlags(argv: readonly string[], file: string): void {
  for (const arg of argv) {
    assertNotForbiddenOrFloorDuplicate(arg.split('=', 1)[0] ?? arg, file)
  }
}

/** A TOML table, as distinct from an array or a scalar. Arrays are objects too, which is the trap. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parses JSON text to a table, or `null` for anything unparseable or not a table -- neither counts as one. */
export function parseRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

/**
 * The one way an args table becomes argv: `--key` for every entry, a bare flag
 * when the value is `true`, the stringified value otherwise, and nothing at all
 * when the value is `false`, `null` or `undefined` — a flag turned off is a flag
 * not passed, never `--key false`.
 */
export function argvFromArgs(args: Record<string, unknown>): string[] {
  const argv: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === false || value === null || value === undefined) {
      continue
    }
    argv.push(`--${key}`)
    if (value !== true) {
      argv.push(String(value))
    }
  }
  return argv
}

/**
 * Every key an args table declares, rendered as a flag regardless of its value.
 * The read-only floor is checked by KEY, so a flag written `= false` must still
 * be seen here — it is the value the floor refuses to let a config decide.
 */
export function argKeysAsFlags(args: Record<string, unknown>): string[] {
  return Object.keys(args).map((key) => `--${key}`)
}

/** Whatever a `catch` produced, as a string — an `Error`'s message, anything else stringified. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const MS_PER_SECOND = 1000

/**
 * Every "wait for the engine to become able to serve" loop: check, then give
 * up only if the deadline has already passed, then sleep. `true` means the
 * check passed, `false` that the deadline did -- what to do about a `false`
 * differs at each call site, so it is the caller's to decide.
 *
 * The check runs before the deadline is ever consulted, so a deadline of
 * `Date.now()` is one probe rather than none.
 */
export async function pollUntil(
  check: () => Promise<boolean>,
  deadline: number,
  intervalMs: number,
): Promise<boolean> {
  for (;;) {
    if (await check()) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await Bun.sleep(intervalMs)
  }
}
