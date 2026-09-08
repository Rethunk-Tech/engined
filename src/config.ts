/**
 * Parses and validates `config.toml` into the shared `Config` shape. Every
 * rule here is fatal at parse: a daemon serving a config it cannot fully
 * trust is worse than one that refuses to start.
 *
 * Five tables, four independent id namespaces (engine, upstream, model,
 * chain), each checked for collisions only against itself -- an engine and
 * an upstream may share an id with no conflict, since nothing before
 * addressing (a later phase) ever compares the two.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, sep as pathSep, resolve as resolvePath } from "node:path";
import { chainHopRoutes, parseHop, routeForChainHop } from "./chain.ts";
import { configPath, dataHome, expandTilde, installDir } from "./paths.ts";
import type {
  Config,
  EngineEntry,
  EngineKind,
  ModelCapabilities,
  ModelEntry,
  ResolvedRoute,
  Role,
  SecretRef,
  Upstream,
  UpstreamTrait,
  VisionKind,
  Wire,
} from "./types.ts";
import {
  argKeysAsFlags,
  assertNoForbiddenFlags,
  EGRESS_RANK,
  isEgress,
  isRecord,
  KIND_TRAITS,
  ParseError,
  qualifiedSegments,
} from "./types.ts";

const DEFAULT_LISTEN_PORT = 29_200;
const DEFAULT_CHAT_TIMEOUT_SECONDS = 600;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600;

const ROLES: readonly Role[] = ["chat", "vision", "embedding"];
const VISION_KINDS: readonly VisionKind[] = ["describe", "read"];

/**
 * `~/.local/share/` in a config path means "wherever engined's own data
 * lives" -- the same base `dataHome()` gives `installDir()` -- not literally
 * the caller's home directory. Routing that one prefix through `dataHome()`
 * is what keeps a configured `models_dir` a sibling of `installDir()` even
 * when `XDG_DATA_HOME` overrides where both live; a bare `expandTilde` never
 * consults it and drifts to `$HOME/.local/share` regardless. Any other tilde
 * path is a literal home-directory reference and expands as one.
 */
const XDG_DATA_TILDE_PREFIX = "~/.local/share/";
function expandConfigPath(p: string): string {
  return p.startsWith(XDG_DATA_TILDE_PREFIX)
    ? join(dataHome(), p.slice(XDG_DATA_TILDE_PREFIX.length))
    : expandTilde(p);
}

/** Closed sets: a typo'd key would otherwise silently do nothing. */
const ENGINE_KEYS = new Set([
  "id",
  "disable",
  "spec_dir",
  "models_dir",
  "models_max",
  "idle_stop_seconds",
  "drain_timeout_seconds",
  "ready_timeout_s",
  "agent_version",
  "kind",
  "args",
]);
const UPSTREAM_KEYS = new Set(["id", "base_url", "secret", "egress", "wire", "disable"]);
const SECRET_KEYS = new Set(["service", "username", "header", "scheme"]);
const MODEL_KEYS = new Set(["id", "input", "output", "context_in", "context_out", "reasoning"]);
const ROUTE_KEYS = new Set([
  "engine",
  "model",
  "wire_model",
  "upstream",
  "filename",
  "role",
  "vision",
  "keep_resident",
  "streaming",
  "args",
  "disable",
  "input",
  "output",
  "context_in",
  "context_out",
  "reasoning",
]);
const CHAIN_KEYS = new Set(["id", "hops", "disable"]);

/** Absent is empty; present-but-not-an-array is a fatal shape error, never a silent zero entries. */
export function asArray(v: unknown, key: string, file: string): unknown[] {
  if (v === undefined) {
    return [];
  }
  if (!Array.isArray(v)) {
    throw new ParseError(`"${key}" must be an array of tables`, file);
  }
  return v;
}

export function requireString(v: unknown, label: string, file: string): string {
  if (typeof v !== "string" || v === "") {
    throw new ParseError(`${label} is missing or empty`, file);
  }
  return v;
}

/** One helper for both optional-typed keys; `kind` selects "string" or "number". */
export function optional<T extends "string" | "number" | "boolean">(
  v: unknown,
  kind: T,
  label: string,
  file: string,
): (T extends "string" ? string : T extends "number" ? number : boolean) | undefined {
  if (v === undefined) {
    return;
  }
  if (typeof v !== kind) {
    throw new ParseError(`${label} must be a ${kind}`, file);
  }
  return v as T extends "string" ? string : T extends "number" ? number : boolean;
}

/** `disable = true` is the only value that ever sets the derived flag; absent or `false` both mean "not disabled", so the flag is never explicitly `false`. */
function parseDisable(
  raw: Record<string, unknown>,
  label: string,
  file: string,
): boolean | undefined {
  return optional(raw.disable, "boolean", `${label} "disable"`, file) === true ? true : undefined;
}

/**
 * Values must be scalar because every consumer renders them with `String(v)` --
 * `argvFromArgs` onto a command line, `iniLines` into the llama preset. A
 * nested table parses as valid TOML and would reach the engine as the literal
 * "[object Object]", so it is refused here rather than shipped silently.
 */
function asArgs(v: unknown, site: string, file: string): Record<string, unknown> {
  if (v === undefined) {
    return {};
  }
  if (!isRecord(v)) {
    throw new ParseError(`${site} "args" must be a table`, file);
  }
  for (const [key, value] of Object.entries(v)) {
    const kind = typeof value;
    if (kind !== "string" && kind !== "number" && kind !== "boolean") {
      throw new ParseError(`${site} "args" key "${key}" must be a string, number or boolean`, file);
    }
  }
  return v;
}

/** Every `[[table]]` entry is checked the same way before any of its fields are read: it must be a table, and an unrecognised key is a typo the operator wants named rather than silently ignored. */
function requireTable(
  raw: unknown,
  site: string,
  keys: ReadonlySet<string>,
  file: string,
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new ParseError(`${site} must be a table`, file);
  }
  for (const key of Object.keys(raw)) {
    if (!keys.has(key)) {
      throw new ParseError(`${site} has unrecognised key "${key}"`, file);
    }
  }
  return raw;
}

function parseSecret(value: unknown, site: string, file: string): SecretRef {
  const v = requireTable(value, `${site} "secret"`, SECRET_KEYS, file);
  return {
    service: requireString(v.service, `${site} "secret.service"`, file),
    username: requireString(v.username, `${site} "secret.username"`, file),
    header: requireString(v.header, `${site} "secret.header"`, file),
    scheme: optional(v.scheme, "string", `${site} "secret.scheme"`, file),
  };
}

function parseKind(
  raw: Record<string, unknown>,
  site: string,
  file: string,
): EngineKind | undefined {
  const kindStr = optional(raw.kind, "string", `${site} "kind"`, file);
  // `Object.hasOwn` against the trait table itself, the same idiom `isEgress`
  // uses and for the same reason: the kinds a config may name are exactly the
  // ones the table answers for, so a new kind is admitted here the moment it
  // is given traits, with no second list to keep in step.
  if (kindStr !== undefined && !Object.hasOwn(KIND_TRAITS, kindStr)) {
    throw new ParseError(`${site} has invalid "kind" "${kindStr}"`, file);
  }
  return kindStr as EngineKind | undefined;
}

function parseEngine(value: unknown, index: number, file: string): EngineEntry {
  const posSite = `engine[${index}]`;
  const raw = requireTable(value, posSite, ENGINE_KEYS, file);
  const id = requireString(raw.id, `${posSite} "id"`, file);
  const site = `engine "${id}"`;
  const rawModelsDir = optional(raw.models_dir, "string", `${site} "models_dir"`, file);
  const agentVersion = optional(raw.agent_version, "string", `${site} "agent_version"`, file);
  const args = asArgs(raw.args, site, file);
  assertNoForbiddenFlags(argKeysAsFlags(args), file);
  const rawSpecDir = optional(raw.spec_dir, "string", `${site} "spec_dir"`, file);
  const drainTimeoutS = optional(
    raw.drain_timeout_seconds,
    "number",
    `${site} "drain_timeout_seconds"`,
    file,
  );
  // Zero reads as "no ceiling" and means the opposite: a single attempt, no
  // wait for a busy container, and a 503 telling the caller the engine has
  // not been free for 0s. Refused here rather than served as a wait nobody
  // asked for.
  if (drainTimeoutS !== undefined && drainTimeoutS <= 0) {
    throw new ParseError(`${site} "drain_timeout_seconds" must be greater than 0`, file);
  }
  return {
    id,
    disabled: parseDisable(raw, site, file),
    spec_dir: rawSpecDir === undefined ? undefined : expandConfigPath(rawSpecDir),
    models_dir: rawModelsDir === undefined ? undefined : expandConfigPath(rawModelsDir),
    models_max: optional(raw.models_max, "number", `${site} "models_max"`, file),
    idle_stop_seconds: optional(
      raw.idle_stop_seconds,
      "number",
      `${site} "idle_stop_seconds"`,
      file,
    ),
    drain_timeout_seconds: drainTimeoutS,
    ready_timeout_s: optional(raw.ready_timeout_s, "number", `${site} "ready_timeout_s"`, file),
    agent_version: agentVersion,
    kind: parseKind(raw, site, file),
    args,
  };
}

function parseUpstream(value: unknown, index: number, file: string): Upstream {
  const posSite = `upstream[${index}]`;
  const raw = requireTable(value, posSite, UPSTREAM_KEYS, file);
  const id = requireString(raw.id, `${posSite} "id"`, file);
  const site = `upstream "${id}"`;
  const egress = optional(raw.egress, "string", `${site} "egress"`, file);
  if (egress === undefined) {
    throw new ParseError(`${site} is missing required "egress"`, file);
  }
  if (!isEgress(egress)) {
    throw new ParseError(
      `${site} "egress" must be one of: ${Object.keys(EGRESS_RANK).join(", ")}`,
      file,
    );
  }
  // "local" always means this box, so a learned upstream name can never point it
  // off-machine. Refused here, before route defaulting reads the literal.
  if (id === "local" && (raw.base_url !== undefined || raw.secret !== undefined)) {
    throw new ParseError(
      `${site} is reserved for this box and cannot carry "base_url" or "secret"`,
      file,
    );
  }
  const wireStr = optional(raw.wire, "string", `${site} "wire"`, file);
  if (wireStr !== undefined && wireStr !== "openai" && wireStr !== "anthropic") {
    throw new ParseError(`${site} has invalid "wire" "${wireStr}"`, file);
  }
  return {
    id,
    base_url: optional(raw.base_url, "string", `${site} "base_url"`, file),
    secret: raw.secret === undefined ? undefined : parseSecret(raw.secret, site, file),
    egress,
    wire: wireStr as Wire | undefined,
    disabled: parseDisable(raw, site, file),
  };
}

const CAPABILITY_FIELDS = ["input", "output", "context_in", "context_out", "reasoning"] as const;

function parseCapabilities(
  raw: Record<string, unknown>,
  site: string,
  file: string,
): ModelCapabilities {
  const stringArray = (key: string): string[] | undefined =>
    raw[key] === undefined
      ? undefined
      : asArray(raw[key], `${site} "${key}"`, file).map((v, i) =>
          requireString(v, `${site} "${key}[${i}]"`, file),
        );
  return {
    input: stringArray("input"),
    output: stringArray("output"),
    context_in: optional(raw.context_in, "number", `${site} "context_in"`, file),
    context_out: optional(raw.context_out, "number", `${site} "context_out"`, file),
    reasoning: stringArray("reasoning"),
  };
}

/** Later layers win field by field: the `[[model]]` row, then what the role implies, then the route's own declaration. */
function mergeCapabilities(...layers: readonly ModelCapabilities[]): ModelCapabilities {
  const merged: ModelCapabilities = {};
  for (const key of CAPABILITY_FIELDS) {
    for (const layer of layers) {
      const v = layer[key];
      if (v !== undefined) {
        (merged as Record<string, unknown>)[key] = v;
      }
    }
  }
  return merged;
}

function parseModel(value: unknown, index: number, file: string): ModelEntry {
  const posSite = `model[${index}]`;
  const raw = requireTable(value, posSite, MODEL_KEYS, file);
  const id = requireString(raw.id, `${posSite} "id"`, file);
  return { id, ...parseCapabilities(raw, `model "${id}"`, file) };
}

/** A route's shape before its `upstream` is defaulted -- that needs every other route on the same engine, which is not known until all of them have been parsed once. */
interface RawRoute {
  engine: string;
  model?: string;
  wire_model?: string;
  declaredUpstream?: string;
  filename?: string;
  role?: Role;
  vision?: VisionKind;
  keep_resident?: boolean;
  streaming?: boolean;
  args: Record<string, unknown>;
  disabledOwn: boolean;
  capabilities: ModelCapabilities;
  site: string;
}

function parseRouteRaw(
  value: unknown,
  index: number,
  file: string,
  engines: Map<string, EngineEntry>,
): RawRoute {
  const posSite = `route[${index}]`;
  const raw = requireTable(value, posSite, ROUTE_KEYS, file);
  const engineId = requireString(raw.engine, `${posSite} "engine"`, file);
  const modelStr = optional(raw.model, "string", `${posSite} "model"`, file);
  const site = `route[${index}] on engine "${engineId}"${modelStr === undefined ? "" : ` model "${modelStr}"`}`;
  if (!engines.has(engineId)) {
    throw new ParseError(`${site} names unknown engine "${engineId}"`, file);
  }
  if (modelStr?.includes("/")) {
    throw new ParseError(
      `${site} has a "model" containing "/", which an address segment cannot express; give it a slash-free "model" and put the id its upstream actually knows in "wire_model"`,
      file,
    );
  }
  const wireModel = optional(raw.wire_model, "string", `${site} "wire_model"`, file);
  const rawFilename = optional(raw.filename, "string", `${site} "filename"`, file);
  const roleStr = optional(raw.role, "string", `${site} "role"`, file);
  if (roleStr !== undefined && !ROLES.includes(roleStr as Role)) {
    throw new ParseError(`${site} has invalid "role" "${roleStr}"`, file);
  }
  const visionStr = optional(raw.vision, "string", `${site} "vision"`, file);
  if (visionStr !== undefined && !VISION_KINDS.includes(visionStr as VisionKind)) {
    throw new ParseError(`${site} has invalid "vision" "${visionStr}"`, file);
  }
  // Fatal rather than ignored: a `vision` on a chat route is someone believing
  // it does something, and a silently dropped key never corrects them.
  if (visionStr !== undefined && roleStr !== "vision") {
    throw new ParseError(`${site} has "vision" but is not role = "vision"`, file);
  }
  // Required rather than defaulted, because the default was the wrong answer
  // for half the vision routes on this box. A reader model left undeclared is
  // sent the describe check and fails it while working correctly, and nothing
  // about that failure says the config is what is wrong. Refusing at parse is
  // the only place that can say so.
  if (roleStr === "vision" && visionStr === undefined) {
    throw new ParseError(
      `${site} is role = "vision" and must declare "vision" ("describe" for a model that reads a scene back, "read" for one that recognises the characters in an image)`,
      file,
    );
  }
  const args = asArgs(raw.args, site, file);
  assertNoForbiddenFlags(argKeysAsFlags(args), file);
  return {
    engine: engineId,
    model: modelStr,
    wire_model: wireModel,
    declaredUpstream: optional(raw.upstream, "string", `${site} "upstream"`, file),
    filename: rawFilename === undefined ? undefined : expandConfigPath(rawFilename),
    role: roleStr as Role | undefined,
    vision: visionStr as VisionKind | undefined,
    keep_resident: optional(raw.keep_resident, "boolean", `${site} "keep_resident"`, file),
    streaming: optional(raw.streaming, "boolean", `${site} "streaming"`, file),
    args,
    disabledOwn: parseDisable(raw, site, file) === true,
    capabilities: parseCapabilities(raw, site, file),
    site,
  };
}

/** What a route's own validation needs to know about the engine it names, read from the one place that carries it. */
interface SpecFacts {
  trait: UpstreamTrait;
  /** A spec-full engine's kind, which config does not restate. `undefined` only when the config's own `kind` already answered. */
  kind?: string;
}

/**
 * A spec-less engine's trait comes from the built-in table keyed by `kind`;
 * a spec-full one declares its own in `engines/<id>/spec.toml`, read directly
 * here rather than through the full `loadSpec` pipeline -- that pipeline also
 * substitutes placeholders and validates the read-only floor, none of which
 * this one flat key needs, and engine parsing must finish before spec loading
 * (`engines.ts`'s `buildEntries`) ever starts.
 */
function specFactsFor(engine: EngineEntry, enginesRoot: string): SpecFacts {
  if (engine.kind !== undefined) {
    return { trait: KIND_TRAITS[engine.kind].upstream, kind: engine.kind };
  }
  const specDir = engine.spec_dir ?? join(enginesRoot, engine.id);
  const specFile = join(specDir, "spec.toml");
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(readFileSync(specFile, "utf8"));
  } catch (err) {
    throw new ParseError(
      `engine "${engine.id}": cannot read its spec to resolve an upstream trait`,
      specFile,
      { cause: err },
    );
  }
  const trait = isRecord(raw) ? raw.upstream : undefined;
  if (trait !== "self" && trait !== "optional" && trait !== "required") {
    throw new ParseError(
      `engine "${engine.id}": spec is missing required "upstream" ("self"|"optional"|"required")`,
      specFile,
    );
  }
  return { trait, kind: isRecord(raw) && typeof raw.kind === "string" ? raw.kind : undefined };
}

/** Every upstream some OTHER route on this engine already names explicitly -- the basis a `required`-trait engine's own default is drawn from. */
function distinctDeclaredUpstreams(engineId: string, raws: readonly RawRoute[]): Set<string> {
  return new Set(
    raws
      .filter((r) => r.engine === engineId && r.declaredUpstream !== undefined)
      .map((r) => r.declaredUpstream as string),
  );
}

/**
 * By the engine's trait: `self` -> `"local"`, `optional` -> `null` (ambient),
 * `required` -> the one upstream every other route on this engine already
 * agrees on -- a `ParseError` naming what was found if there is zero or more
 * than one candidate, since there is no single answer to default to.
 */
function defaultUpstreamFor(
  engineId: string,
  trait: UpstreamTrait,
  site: string,
  allRaws: readonly RawRoute[],
  file: string,
): string | null {
  if (trait === "optional") {
    return null;
  }
  if (trait === "self") {
    return "local";
  }
  const distinct = distinctDeclaredUpstreams(engineId, allRaws);
  if (distinct.size !== 1) {
    const names = [...distinct].join(", ") || "none";
    throw new ParseError(
      `${site} names no "upstream" and engine "${engineId}" is "required" to have exactly one across its routes; found: ${names}`,
      file,
    );
  }
  return [...distinct][0] as string;
}

/**
 * The parse-tier half of the filename/role/args split: everything decidable
 * without `kind`, which is not known until specs load in `engines.ts`'s
 * `buildEntries`. That is where the kind-dependent half of this same
 * question -- whisper requires `filename` and forbids `role`, llama requires
 * both -- is checked instead.
 */
function localFileForbiddenReason(
  model: string | undefined,
  upstreamId: string | null,
  engine: EngineEntry,
): string | undefined {
  if (model === undefined) {
    return "there is no model whose weights they could describe";
  }
  if (upstreamId !== "local") {
    return "a route proxied elsewhere has no local file to describe";
  }
  if (engine.models_dir === undefined) {
    return `engine "${engine.id}" has no local model store to host it`;
  }
  return undefined;
}

function resolveRoute(
  raw: RawRoute,
  allRaws: readonly RawRoute[],
  engines: Map<string, EngineEntry>,
  upstreams: Map<string, Upstream>,
  models: Map<string, ModelEntry>,
  traitFor: (engine: EngineEntry) => SpecFacts,
  file: string,
): ResolvedRoute {
  const engine = engines.get(raw.engine) as EngineEntry;
  const upstreamId =
    raw.declaredUpstream === undefined
      ? defaultUpstreamFor(raw.engine, traitFor(engine).trait, raw.site, allRaws, file)
      : raw.declaredUpstream;
  if (upstreamId !== null && !upstreams.has(upstreamId)) {
    throw new ParseError(`${raw.site} names unknown upstream "${upstreamId}"`, file);
  }
  const upstream = upstreamId === null ? undefined : upstreams.get(upstreamId);

  const reason = localFileForbiddenReason(raw.model, upstreamId, engine);
  if (reason !== undefined) {
    if (raw.filename !== undefined) {
      throw new ParseError(`${raw.site} must not declare "filename": ${reason}`, file);
    }
    if (raw.role !== undefined) {
      throw new ParseError(`${raw.site} must not declare "role": ${reason}`, file);
    }
    // A comfy route is the exception, and only for args: it is modelless, so
    // there is no GGUF for these to describe, but `POST /openai/v1/images/
    // generations` reads them as the checkpoint names its shipped graph loads.
    // `filename` and `role` above stay forbidden -- those really are about a
    // local weights file, and comfy has none.
    if (Object.keys(raw.args).length > 0 && traitFor(engine).kind !== "comfy") {
      throw new ParseError(`${raw.site} declares "args" that nothing reads: ${reason}`, file);
    }
  }

  const baseCaps = raw.model === undefined ? {} : (models.get(raw.model) ?? {});
  const disabled =
    raw.disabledOwn || engine.disabled === true || upstream?.disabled === true ? true : undefined;

  return {
    engine: raw.engine,
    model: raw.model,
    wire_model: raw.wire_model,
    upstream: upstreamId,
    filename: raw.filename,
    role: raw.role,
    vision: raw.vision,
    keep_resident: raw.keep_resident,
    streaming: raw.streaming,
    args: raw.args,
    disabled,
    ...mergeCapabilities(baseCaps, roleCapabilities(raw.role), raw.capabilities),
  };
}

/**
 * What a role already says about a route's modalities, so a consumer reading
 * the door sees it without a hand-written `[[model]]` row: a `vision` route
 * takes images, a `chat` route takes text, both answer in text. An embedding
 * route says nothing here -- its output is not a modality a caller sends.
 */
function roleCapabilities(role: Role | undefined): ModelCapabilities {
  if (role === "vision") {
    return { input: ["text", "image"], output: ["text"] };
  }
  if (role === "chat") {
    return { input: ["text"], output: ["text"] };
  }
  return {};
}

/** The one rule that keeps a two-segment address single-valued: an engine is modelless routes or model-bearing ones, never both. */
function checkModellessMixing(routes: readonly ResolvedRoute[], file: string): void {
  const seen = new Map<string, boolean>();
  for (const r of routes) {
    const modelless = r.model === undefined;
    const prior = seen.get(r.engine);
    if (prior === undefined) {
      seen.set(r.engine, modelless);
      continue;
    }
    if (prior !== modelless) {
      throw new ParseError(
        `engine "${r.engine}" carries both a modelless route and a model-bearing route; an engine must be one or the other`,
        file,
      );
    }
  }
}

function validateFilenameUnderModelsDir(
  routes: readonly ResolvedRoute[],
  engines: Map<string, EngineEntry>,
  file: string,
): void {
  for (const r of routes) {
    if (r.filename === undefined) {
      continue;
    }
    const engine = engines.get(r.engine);
    if (engine?.models_dir === undefined) {
      continue;
    }
    const dir = resolvePath(engine.models_dir);
    const target = resolvePath(dir, r.filename);
    const label = `route on engine "${engine.id}" model "${r.model ?? ""}"`;
    if (target !== dir && !target.startsWith(dir + pathSep)) {
      throw new ParseError(`${label} "filename" is not under engine's "models_dir"`, file);
    }
    if (!existsSync(target)) {
      throw new ParseError(`${label} "filename" does not exist at "${target}"`, file);
    }
  }
}

/**
 * Both of these are unsatisfiable rather than merely unwise, so they are fatal
 * here instead of surprising at runtime: occupancy is one model per role.
 * Filtered on `(engine, upstream === "local")`: a route proxied to a peer's
 * llama has nothing resident on this box to hold a lease over.
 *
 * There is deliberately no check against `models_max`. Every pinned role has
 * a route, `validateModelsMax` already refuses a `models_max` below the
 * engine's distinct local role count, and the pinned roles are a subset of
 * those -- so a pinned set can never exceed it, and a guard here would be
 * unreachable.
 */
function validateKeepResident(
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  file: string,
): void {
  for (const e of engines) {
    const pinned = routes.filter(
      (r) => r.engine === e.id && r.upstream === "local" && r.keep_resident === true,
    );
    const byRole = new Map<string, string[]>();
    for (const r of pinned) {
      if (r.role === undefined) {
        throw new ParseError(
          `route on engine "${e.id}" model "${r.model ?? ""}" declares "keep_resident" but has no "role": nothing holds it resident`,
          file,
        );
      }
      byRole.set(r.role, [...(byRole.get(r.role) ?? []), r.model ?? e.id]);
    }
    for (const [role, ids] of byRole) {
      if (ids.length > 1) {
        throw new ParseError(
          `engine "${e.id}" role "${role}" has ${ids.length} routes declaring "keep_resident" (${ids.join(", ")}): only one model per role can be resident`,
          file,
        );
      }
    }
  }
}

function validateModelsMax(
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  file: string,
): void {
  for (const e of engines) {
    if (e.models_max === undefined) {
      continue;
    }
    const roles = new Set(
      routes
        .filter((r) => r.engine === e.id && r.upstream === "local" && r.role)
        .map((r) => r.role),
    );
    if (e.models_max < roles.size) {
      throw new ParseError(
        `engine "${e.id}" "models_max" ${e.models_max} is below its ${roles.size} distinct configured roles`,
        file,
      );
    }
  }
}

function claimName(seen: Map<string, string>, name: string, site: string, file: string): void {
  const prior = seen.get(name);
  if (prior !== undefined) {
    throw new ParseError(`"${name}" is declared twice: ${prior} and ${site}`, file);
  }
  seen.set(name, site);
}

/** Every `id` in one table declared once. Tables are checked only against themselves: an engine, an upstream and a model may share a name. */
function checkCollisions(items: readonly { id: string }[], label: string, file: string): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    claimName(seen, item.id, `${label} "${item.id}"`, file);
  }
}

/**
 * One chain's hops, minus any whose resolved (engine, upstream, model)
 * address is disabled -- through the engine, the upstream, or the route
 * itself. Split out of `parseChains` so each half is one job.
 */
function parseChainHops(
  name: string,
  hops: readonly string[],
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  file: string,
): string[] {
  const kept: string[] = [];
  for (const [i, hop] of hops.entries()) {
    // `@/<engine>/<model>` and `@/<engine>/<upstream>/<model>` are the only hop shapes.
    const segs = qualifiedSegments(hop);
    if (segs === undefined || segs.length === 1) {
      throw new ParseError(
        `chain "${name}"[${i}] "${hop}" is not a fully-qualified "@/<engine>/<model>" or "@/<engine>/<upstream>/<model>" hop`,
        file,
      );
    }
    // `local` is a real upstream id, never an engine one: a hop names an
    // engine by its actual id, same as every other address form.
    const { engine: engineId, model } = parseHop(hop);
    if (!engines.some((e) => e.id === engineId)) {
      throw new ParseError(`chain hop "${hop}": engine "${engineId}" does not exist`, file);
    }
    const { candidates: declared, modelless } = chainHopRoutes(routes, hop);
    const route = routeForChainHop(routes, hop);
    if (route === undefined) {
      // A hop onto a disabled engine, upstream or route drops out rather than
      // failing parse: the point of disabling one is that the chains naming it
      // keep working on what is left. An address that names nothing at all,
      // or resolves to nothing served for any other reason, is still a parse
      // error.
      if (declared.length > 0 && declared.every((r) => r.disabled === true)) {
        continue;
      }
      throw new ParseError(
        modelless
          ? `chain "${name}"[${i}] "${hop}": "${engineId}" is modelless and has no route with upstream "${model}"`
          : `chain "${name}"[${i}] "${hop}": model "${model}" does not exist on "${engineId}"`,
        file,
      );
    }
    kept.push(hop);
  }
  return kept;
}

interface RawChain {
  id: string;
  hops: string[];
  disabled: boolean;
}

function parseChainRaw(value: unknown, index: number, file: string): RawChain {
  const posSite = `chain[${index}]`;
  const raw = requireTable(value, posSite, CHAIN_KEYS, file);
  const id = requireString(raw.id, `${posSite} "id"`, file);
  const site = `chain "${id}"`;
  const hopsRaw = asArray(raw.hops, `${site} "hops"`, file);
  if (hopsRaw.length === 0) {
    throw new ParseError(`${site} has no hops`, file);
  }
  const hops = hopsRaw.map((h, i) => requireString(h, `${site} "hops[${i}]"`, file));
  return { id, hops, disabled: parseDisable(raw, site, file) === true };
}

function parseChains(
  raw: unknown,
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  file: string,
): Record<string, string[]> {
  const rawChains = asArray(raw, "chain", file).map((c, i) => parseChainRaw(c, i, file));

  checkCollisions(rawChains, "chain", file);

  const chains: Record<string, string[]> = {};
  for (const c of rawChains) {
    // A disabled chain is not served at all -- its own top-level flag, not a
    // resolved-hop question the way an engine/upstream/route's is.
    if (c.disabled) {
      continue;
    }
    const hops = parseChainHops(c.id, c.hops, engines, routes, file);
    // Nothing left to route to: the chain goes with its hops rather than
    // resolving to an empty list a request would fall off the end of.
    if (hops.length > 0) {
      chains[c.id] = hops;
    }
  }
  return chains;
}

/**
 * `enginesRoot` defaults to the installed `engines/` tree so a production
 * `loadConfig()` call needs no argument; a test that ships its own fixture
 * specs passes one explicitly.
 */
export function loadConfig(path?: string, enginesRoot?: string): Config {
  const file = path ?? configPath();
  const root = enginesRoot ?? join(installDir(), "engines");
  const raw = readConfigTable(file);

  const engines = asArray(raw.engine, "engine", file).map((e, i) => parseEngine(e, i, file));
  checkCollisions(engines, "engine", file);
  const engineMap = new Map(engines.map((e) => [e.id, e]));

  const upstreams = asArray(raw.upstream, "upstream", file).map((u, i) =>
    parseUpstream(u, i, file),
  );
  checkCollisions(upstreams, "upstream", file);
  const upstreamMap = new Map(upstreams.map((u) => [u.id, u]));

  const models = asArray(raw.model, "model", file).map((m, i) => parseModel(m, i, file));
  checkCollisions(models, "model", file);
  const modelMap = new Map(models.map((m) => [m.id, m]));

  const rawRoutes = asArray(raw.route, "route", file).map((r, i) =>
    parseRouteRaw(r, i, file, engineMap),
  );

  const traitFor = cachedTraitFor(root);
  const routes = rawRoutes.map((r) =>
    resolveRoute(r, rawRoutes, engineMap, upstreamMap, modelMap, traitFor, file),
  );

  checkModellessMixing(routes, file);
  validateFilenameUnderModelsDir(routes, engineMap, file);
  validateKeepResident(engines, routes, file);
  validateModelsMax(engines, routes, file);

  const chains = parseChains(raw.chain, engines, routes, file);

  return {
    ...parseTopLevelSettings(raw, file),
    engines,
    upstreams,
    routes,
    chains,
  };
}

/** The config file as a parsed TOML table; every read or parse failure is a ParseError naming the file. */
function readConfigTable(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new ParseError("cannot read config", file, { cause: err });
  }

  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (err) {
    throw new ParseError("invalid TOML", file, { cause: err });
  }
  if (!isRecord(raw)) {
    throw new ParseError("config must be a table", file);
  }
  return raw;
}

/** A spec is read at most once per engine no matter how many routes name it. */
function cachedTraitFor(enginesRoot: string): (engine: EngineEntry) => SpecFacts {
  const cache = new Map<string, SpecFacts>();
  return (engine) => {
    let facts = cache.get(engine.id);
    if (facts === undefined) {
      facts = specFactsFor(engine, enginesRoot);
      cache.set(engine.id, facts);
    }
    return facts;
  };
}

function parseTopLevelSettings(
  raw: Record<string, unknown>,
  file: string,
): Pick<Config, "listen_port" | "chat_timeout_seconds" | "agent_timeout_seconds"> {
  return {
    listen_port:
      optional(raw.listen_port, "number", 'config "listen_port"', file) ?? DEFAULT_LISTEN_PORT,
    chat_timeout_seconds:
      optional(raw.chat_timeout_seconds, "number", 'config "chat_timeout_seconds"', file) ??
      DEFAULT_CHAT_TIMEOUT_SECONDS,
    agent_timeout_seconds:
      optional(raw.agent_timeout_seconds, "number", 'config "agent_timeout_seconds"', file) ??
      DEFAULT_AGENT_TIMEOUT_SECONDS,
  };
}
