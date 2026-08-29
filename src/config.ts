/**
 * Parses and validates `config.toml` into the shared `Config` shape. Every
 * rule here is fatal at parse: a daemon serving a config it cannot fully
 * trust is worse than one that refuses to start.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, sep as pathSep, resolve as resolvePath } from "node:path";
import { configPath, dataHome, expandTilde } from "./paths.ts";
import type { Config, EngineEntry, EngineKind, ModelEntry, Role, SecretRef } from "./types.ts";
import {
  argKeysAsFlags,
  assertNoForbiddenFlags,
  ENGINE_KINDS,
  isRecord,
  ParseError,
  QUALIFIED_MODEL_RE,
} from "./types.ts";

const DEFAULT_LISTEN_PORT = 29_200;
const DEFAULT_CHAT_TIMEOUT_SECONDS = 600;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600;

const ROLES: readonly Role[] = ["chat", "vision", "embedding"];

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

/** Closed: a typo'd key here would otherwise silently do nothing. */
const ENGINE_KEYS = new Set([
  "id",
  "egress",
  "spec_dir",
  "models_dir",
  "models_max",
  "idle_stop_seconds",
  "ready_timeout_s",
  "claude_version",
  "kind",
  "base_url",
  "secret",
  "args",
]);
const MODEL_KEYS = new Set([
  "id",
  "engine",
  "filename",
  "role",
  "aliases",
  "args",
  "keep_resident",
]);

/** Absent is empty; present-but-not-an-array is a fatal shape error, never a silent zero entries. */
function asArray(v: unknown, key: string, file: string): unknown[] {
  if (v === undefined) {
    return [];
  }
  if (!Array.isArray(v)) {
    throw new ParseError(`"${key}" must be an array of tables`, file);
  }
  return v;
}
/**
 * A model on this engine has a resident local file to account for. That is
 * never true for a remote address: `checkRemoteAddress` already forbids
 * `models_dir` there structurally, so it has no file to check a `filename`
 * against regardless of what kind it is (agentic-cli, or an openai-http
 * endpoint hosted elsewhere). Conflating "no local file" with "agentic"
 * yields the wrong message, which is why the test is on the two fields
 * rather than on kind.
 */
function requiresFilenameAndRole(e: EngineEntry): boolean {
  return e.base_url === undefined && e.models_dir !== undefined;
}

function requireString(v: unknown, label: string, file: string): string {
  if (typeof v !== "string" || v === "") {
    throw new ParseError(`${label} is missing or empty`, file);
  }
  return v;
}

/** One helper for both optional-typed keys; `kind` selects "string" or "number". */
function optional<T extends "string" | "number" | "boolean">(
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

function parseSecret(v: unknown, site: string, file: string): SecretRef {
  if (!isRecord(v)) {
    throw new ParseError(`${site} "secret" must be a table`, file);
  }
  return {
    service: requireString(v.service, `${site} "secret.service"`, file),
    username: requireString(v.username, `${site} "secret.username"`, file),
    header: requireString(v.header, `${site} "secret.header"`, file),
  };
}

function parseKind(
  raw: Record<string, unknown>,
  site: string,
  file: string,
): EngineKind | undefined {
  const kindStr = optional(raw.kind, "string", `${site} "kind"`, file);
  if (kindStr !== undefined && !(ENGINE_KINDS as readonly string[]).includes(kindStr)) {
    throw new ParseError(`${site} has invalid "kind" "${kindStr}"`, file);
  }
  return kindStr as EngineKind | undefined;
}

/** A remote address launches nothing: base_url gates its own required/forbidden keys. */
function checkRemoteAddress(raw: Record<string, unknown>, site: string, file: string): void {
  if (raw.base_url === undefined) {
    return;
  }
  if (raw.secret === undefined) {
    throw new ParseError(`${site} is a remote address and is missing required "secret"`, file);
  }
  for (const forbidden of ["spec_dir", "models_dir", "models_max"] as const) {
    if (raw[forbidden] !== undefined) {
      throw new ParseError(`${site} is a remote address and must not declare "${forbidden}"`, file);
    }
  }
}

function parseEngine(raw: unknown, index: number, file: string): EngineEntry {
  const posSite = `engine[${index}]`;
  if (!isRecord(raw)) {
    throw new ParseError(`${posSite} must be a table`, file);
  }
  for (const key of Object.keys(raw)) {
    if (!ENGINE_KEYS.has(key)) {
      throw new ParseError(`${posSite} has unrecognised key "${key}"`, file);
    }
  }
  const id = requireString(raw.id, `${posSite} "id"`, file);
  const site = `engine "${id}"`;
  if (raw.egress !== "none" && raw.egress !== "remote") {
    throw new ParseError(`${site} is missing required "egress"`, file);
  }
  const { egress } = raw as { egress: "none" | "remote" };

  checkRemoteAddress(raw, site, file);
  const rawModelsDir = optional(raw.models_dir, "string", `${site} "models_dir"`, file);
  const claudeVersion = optional(raw.claude_version, "string", `${site} "claude_version"`, file);
  const args = asArgs(raw.args, site, file);
  assertNoForbiddenFlags(argKeysAsFlags(args), file);
  const rawSpecDir = optional(raw.spec_dir, "string", `${site} "spec_dir"`, file);
  return {
    id,
    egress,
    spec_dir: rawSpecDir === undefined ? undefined : expandConfigPath(rawSpecDir),
    models_dir: rawModelsDir === undefined ? undefined : expandConfigPath(rawModelsDir),
    models_max: optional(raw.models_max, "number", `${site} "models_max"`, file),
    idle_stop_seconds: optional(
      raw.idle_stop_seconds,
      "number",
      `${site} "idle_stop_seconds"`,
      file,
    ),
    ready_timeout_s: optional(raw.ready_timeout_s, "number", `${site} "ready_timeout_s"`, file),
    claude_version: claudeVersion,
    kind: parseKind(raw, site, file),
    base_url: optional(raw.base_url, "string", `${site} "base_url"`, file),
    secret: raw.secret === undefined ? undefined : parseSecret(raw.secret, site, file),
    args,
  };
}

function parseModel(raw: unknown, index: number, file: string): ModelEntry {
  const posSite = `model[${index}]`;
  if (!isRecord(raw)) {
    throw new ParseError(`${posSite} must be a table`, file);
  }
  for (const key of Object.keys(raw)) {
    if (!MODEL_KEYS.has(key)) {
      throw new ParseError(`${posSite} has unrecognised key "${key}"`, file);
    }
  }
  const id = requireString(raw.id, `${posSite} "id"`, file);
  const site = `model "${id}"`;
  const engine = requireString(raw.engine, `${site} "engine"`, file);
  const aliases = asArray(raw.aliases, "aliases", file).map((a, i) =>
    requireString(a, `${site} "aliases[${i}]"`, file),
  );

  const rawFilename = optional(raw.filename, "string", `${site} "filename"`, file);
  const filename = rawFilename === undefined ? undefined : expandConfigPath(rawFilename);

  const roleStr = optional(raw.role, "string", `${site} "role"`, file);
  if (roleStr !== undefined && !ROLES.includes(roleStr as Role)) {
    throw new ParseError(`${site} has invalid "role" "${roleStr}"`, file);
  }

  const args = asArgs(raw.args, site, file);
  assertNoForbiddenFlags(argKeysAsFlags(args), file);

  return {
    id,
    engine,
    filename,
    role: roleStr as Role | undefined,
    aliases,
    args,
    keep_resident: optional(raw.keep_resident, "boolean", `${site} "keep_resident"`, file),
  };
}

function validateModelAgainstEngine(
  m: ModelEntry,
  engines: Map<string, EngineEntry>,
  file: string,
): void {
  const engine = engines.get(m.engine);
  if (!engine) {
    throw new ParseError(`model "${m.id}" names unknown engine "${m.engine}"`, file);
  }
  const site = `model "${m.id}" on engine "${engine.id}"`;

  if (!requiresFilenameAndRole(engine)) {
    if (m.filename !== undefined) {
      throw new ParseError(
        `${site} must not declare "filename": engine "${engine.id}" has no local model store to host it`,
        file,
      );
    }
    if (m.role !== undefined) {
      throw new ParseError(
        `${site} must not declare "role": engine "${engine.id}" has no local model store to host it`,
        file,
      );
    }
    // A model's own [model.args] reaches argv only through llama's preset-INI
    // renderer (engine.args under m.args), which runs exclusively for a model
    // on a models_dir-hosting engine -- the same engines that require
    // filename and role.
    // Anywhere else it is parsed, forbidden-flag-checked, and never read
    // again -- the same accept-and-drop failure the closed key sets exist to
    // prevent, so it is rejected here rather than silently ignored.
    if (Object.keys(m.args).length > 0) {
      throw new ParseError(
        `${site} declares "args" that nothing reads: engine "${engine.id}" has no local model store to render them into`,
        file,
      );
    }
    return;
  }
  if (m.filename === undefined) {
    throw new ParseError(`${site} is missing required "filename"`, file);
  }
  if (m.role === undefined) {
    throw new ParseError(`${site} is missing required "role"`, file);
  }
  const dir = resolvePath(engine.models_dir as string);
  const target = resolvePath(dir, m.filename);
  if (target !== dir && !target.startsWith(dir + pathSep)) {
    throw new ParseError(`${site} "filename" is not under engine's "models_dir"`, file);
  }
  if (!existsSync(target)) {
    throw new ParseError(`${site} "filename" does not exist at "${target}"`, file);
  }
}

/**
 * Both of these are unsatisfiable rather than merely unwise, so they are fatal
 * here instead of surprising at runtime: occupancy is one model per role.
 *
 * There is deliberately no check against `models_max`. Every pinned model has
 * a role, `validateModelsMax` already refuses a `models_max` below the engine's
 * distinct role count, and the pinned roles are a subset of those -- so a
 * pinned set can never exceed it, and a guard here would be unreachable.
 */
function validateKeepResident(engines: EngineEntry[], models: ModelEntry[], file: string): void {
  for (const e of engines) {
    const pinned = models.filter((m) => m.engine === e.id && m.keep_resident === true);
    const byRole = new Map<string, string[]>();
    for (const m of pinned) {
      if (m.role === undefined) {
        throw new ParseError(
          `model "${m.id}" declares "keep_resident" but has no "role": nothing on engine "${e.id}" holds it resident`,
          file,
        );
      }
      byRole.set(m.role, [...(byRole.get(m.role) ?? []), m.id]);
    }
    for (const [role, ids] of byRole) {
      if (ids.length > 1) {
        throw new ParseError(
          `engine "${e.id}" role "${role}" has ${ids.length} models declaring "keep_resident" (${ids.join(", ")}): only one model per role can be resident`,
          file,
        );
      }
    }
  }
}

function validateModelsMax(engines: EngineEntry[], models: ModelEntry[], file: string): void {
  for (const e of engines) {
    if (e.models_max === undefined) {
      continue;
    }
    const roles = new Set(models.filter((m) => m.engine === e.id && m.role).map((m) => m.role));
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

/** Ids and aliases share one namespace; "local" is reserved before any config is read. */
function checkNamespaceCollisions(
  engines: EngineEntry[],
  models: ModelEntry[],
  file: string,
): void {
  const seen = new Map<string, string>();
  claimName(seen, "local", 'reserved alias "local" (the default local engine)', file);
  for (const e of engines) {
    claimName(seen, e.id, `engine "${e.id}"`, file);
  }
  for (const m of models) {
    claimName(seen, m.id, `model "${m.id}"`, file);
    for (const a of m.aliases) {
      claimName(seen, a, `model "${m.id}" alias "${a}"`, file);
    }
  }
}

/**
 * `local` resolves to the one no-egress engine that at least one `[[model]]`
 * names. A `models_dir` is not that signal: Comfy carries one too, for its
 * own bind mount, and serves no model -- it is reached by starting the
 * engine directly, never by a chain hop. The one implementation parse time
 * (this file, which turns "not exactly one" fatal) and runtime
 * (`dispatch.ts`'s `resolveEngineSegment`, which returns undefined the same
 * as any other unresolved id) both call, so the two rules cannot drift back
 * out of agreement with each other.
 */
export function resolveLocalCandidates(
  engines: readonly EngineEntry[],
  models: readonly ModelEntry[],
): EngineEntry[] {
  return engines.filter(
    (e) => !e.disabled && e.egress === "none" && models.some((m) => m.engine === e.id),
  );
}

/** Everything both halves of chain parsing read; one object so neither runs past the parameter budget. */
interface ChainCtx {
  engines: EngineEntry[];
  models: ModelEntry[];
  disabled: Set<string>;
  file: string;
}

function resolveEngineHalf(seg: string, ctx: ChainCtx, hop: string): void {
  const { engines, models, file } = ctx;
  if (seg !== "local") {
    if (!engines.some((e) => e.id === seg)) {
      throw new ParseError(`chain hop "${hop}": engine "${seg}" does not exist`, file);
    }
    return;
  }
  const candidates = resolveLocalCandidates(engines, models);
  if (candidates.length !== 1) {
    const names = candidates.map((e) => e.id).join(", ") || "none";
    throw new ParseError(
      `chain hop "${hop}": "local" must resolve to exactly one engine with egress "none" that serves a model; candidates: ${names}`,
      file,
    );
  }
}

/**
 * Names of engines and chains that are configured but not served. One
 * top-level list rather than a per-entry flag because `[chain]` is a table of
 * hop arrays with nowhere to hang one, and because the operator question is
 * "what is off right now", which one list answers.
 */
function parseDisabled(
  raw: Record<string, unknown>,
  declaredEngines: readonly EngineEntry[],
  file: string,
): Set<string> {
  const names = new Set(
    asArray(raw.disabled, "disabled", file).map((n, i) =>
      requireString(n, `"disabled[${i}]"`, file),
    ),
  );
  const chainNames = isRecord(raw.chain) ? Object.keys(raw.chain) : [];
  for (const name of names) {
    if (!(declaredEngines.some((e) => e.id === name) || chainNames.includes(name))) {
      throw new ParseError(`"disabled" names "${name}", which is no engine or chain here`, file);
    }
  }
  return names;
}

/** One chain's hops, minus any onto a disabled engine. Split out of `parseChains` so each half is one job. */
function parseChainHops(
  name: string,
  arr: unknown[],
  ctx: ChainCtx,
  modelNames: Set<string>,
): string[] {
  const { file, disabled } = ctx;
  const hops: string[] = [];
  for (const [i, hopRaw] of arr.entries()) {
    if (typeof hopRaw !== "string") {
      throw new ParseError(`chain "${name}"[${i}] must be a string`, file);
    }
    const match = QUALIFIED_MODEL_RE.exec(hopRaw);
    const engineSeg = match?.[1];
    const modelSeg = match?.[2];
    if (!(engineSeg && modelSeg)) {
      throw new ParseError(
        `chain "${name}"[${i}] "${hopRaw}" is not a fully-qualified "@/<engine>/<model>" hop`,
        file,
      );
    }
    // A hop onto a disabled engine drops out rather than failing parse: the
    // point of disabling one is that the chains naming it keep working on
    // what is left. Its model is gone with it, so validating either half
    // here would report a hole this file just made.
    if (disabled.has(engineSeg)) {
      continue;
    }
    resolveEngineHalf(engineSeg, ctx, hopRaw);
    if (!modelNames.has(modelSeg)) {
      throw new ParseError(
        `chain "${name}"[${i}] "${hopRaw}": model "${modelSeg}" does not exist`,
        file,
      );
    }
    hops.push(hopRaw);
  }
  return hops;
}

function parseChains(raw: unknown, ctx: ChainCtx): Record<string, string[]> {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new ParseError('"chain" must be a table', ctx.file);
  }
  const modelNames = new Set(ctx.models.flatMap((m) => [m.id, ...m.aliases]));
  const chains: Record<string, string[]> = {};
  for (const [name, hopsRaw] of Object.entries(raw)) {
    const arr = asArray(hopsRaw, `chain.${name}`, ctx.file);
    if (arr.length === 0) {
      throw new ParseError(`chain "${name}" has no hops`, ctx.file);
    }
    if (ctx.disabled.has(name)) {
      continue;
    }
    const hops = parseChainHops(name, arr, ctx, modelNames);
    // Nothing left to route to: the chain goes with its hops rather than
    // resolving to an empty list a request would fall off the end of.
    if (hops.length > 0) {
      chains[name] = hops;
    }
  }
  return chains;
}

export function loadConfig(path?: string): Config {
  const file = path ?? configPath();

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

  const declaredEngines = asArray(raw.engine, "engine", file).map((e, i) =>
    parseEngine(e, i, file),
  );
  const declaredModels = asArray(raw.model, "model", file).map((m, i) => parseModel(m, i, file));

  const disabled = parseDisabled(raw, declaredEngines, file);
  // A disabled engine keeps its entry, marked -- `GET /v1/engines` reports it
  // as off rather than losing it. Everything that would VALIDATE it is what
  // drops: its models and its chain hops go, so an engine can be turned off
  // precisely because its weights or its secret are not on this box.
  const engines = declaredEngines.map((e) => (disabled.has(e.id) ? { ...e, disabled: true } : e));
  const models = declaredModels.filter((m) => !disabled.has(m.engine));
  checkNamespaceCollisions(engines, models, file);

  const engineMap = new Map(engines.map((e) => [e.id, e]));
  for (const m of models) {
    validateModelAgainstEngine(m, engineMap, file);
  }
  validateModelsMax(engines, models, file);
  validateKeepResident(engines, models, file);

  const chains = parseChains(raw.chain, { engines, models, disabled, file });

  return {
    listen_port:
      optional(raw.listen_port, "number", 'config "listen_port"', file) ?? DEFAULT_LISTEN_PORT,
    chat_timeout_seconds:
      optional(raw.chat_timeout_seconds, "number", 'config "chat_timeout_seconds"', file) ??
      DEFAULT_CHAT_TIMEOUT_SECONDS,
    agent_timeout_seconds:
      optional(raw.agent_timeout_seconds, "number", 'config "agent_timeout_seconds"', file) ??
      DEFAULT_AGENT_TIMEOUT_SECONDS,
    models,
    engines,
    chains,
  };
}
