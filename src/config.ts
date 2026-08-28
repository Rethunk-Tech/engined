/**
 * Parses and validates `config.toml` into the shared `Config` shape. Every
 * rule here is fatal at parse: a daemon serving a config it cannot fully
 * trust is worse than one that refuses to start.
 */
import { existsSync, readFileSync } from "node:fs";
import { sep as pathSep, resolve as resolvePath } from "node:path";
import { configPath, expandTilde } from "./paths.ts";
import type { Config, EngineEntry, EngineKind, ModelEntry, Role, SecretRef } from "./types.ts";
import { assertNoForbiddenFlags, isRecord, ParseError } from "./types.ts";

const DEFAULT_LISTEN_PORT = 29_200;
const DEFAULT_CHAT_TIMEOUT_SECONDS = 600;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600;

const ROLES: readonly Role[] = ["chat", "vision", "embedding"];
const ENGINE_KINDS: readonly EngineKind[] = ["openai-http", "agentic-cli", "tts", "stt", "comfy"];

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
const MODEL_KEYS = new Set(["id", "engine", "filename", "role", "aliases", "args"]);
const HOP_RE = /^@\/([^/]+)\/([^/]+)$/;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/**
 * A model on this engine has a resident local file to account for. That is
 * never true for a remote address: `checkRemoteAddress` already forbids
 * `models_dir` there structurally, so it has no file to check a `filename`
 * against regardless of what kind it is (agentic-cli, or an openai-http
 * endpoint hosted elsewhere) -- conflating "no local file" with "agentic"
 * is exactly the wrong-message bug this predicate used to carry.
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
function optional<T extends "string" | "number">(
  v: unknown,
  kind: T,
  label: string,
  file: string,
): (T extends "string" ? string : number) | undefined {
  if (v === undefined) {
    return;
  }
  if (typeof v !== kind) {
    throw new ParseError(`${label} must be a ${kind}`, file);
  }
  return v as T extends "string" ? string : number;
}

function asArgs(v: unknown, site: string, file: string): Record<string, unknown> {
  if (v === undefined) {
    return {};
  }
  if (!isRecord(v)) {
    throw new ParseError(`${site} "args" must be a table`, file);
  }
  return v;
}

/** Close enough to how an args table renders to argv to catch a forbidden flag by key. */
function argsToArgv(args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    argv.push(`--${k}`);
    if (v !== true) {
      argv.push(String(v));
    }
  }
  return argv;
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
  assertNoForbiddenFlags(argsToArgv(args), file);
  return {
    id,
    egress,
    spec_dir: optional(raw.spec_dir, "string", `${site} "spec_dir"`, file),
    models_dir: rawModelsDir === undefined ? undefined : expandTilde(rawModelsDir),
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
  const aliases = asArray(raw.aliases).map((a, i) =>
    requireString(a, `${site} "aliases[${i}]"`, file),
  );

  const rawFilename = optional(raw.filename, "string", `${site} "filename"`, file);
  const filename = rawFilename === undefined ? undefined : expandTilde(rawFilename);

  const roleStr = optional(raw.role, "string", `${site} "role"`, file);
  if (roleStr !== undefined && !ROLES.includes(roleStr as Role)) {
    throw new ParseError(`${site} has invalid "role" "${roleStr}"`, file);
  }

  const args = asArgs(raw.args, site, file);
  assertNoForbiddenFlags(argsToArgv(args), file);

  return { id, engine, filename, role: roleStr as Role | undefined, aliases, args };
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
    // renderer (resolveArgs(engine.args, m.args)), which runs exclusively for
    // a model on the same models_dir-hosting engine filename/role require.
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
  return engines.filter((e) => e.egress === "none" && models.some((m) => m.engine === e.id));
}

function resolveEngineHalf(
  seg: string,
  ctx: { engines: EngineEntry[]; models: ModelEntry[]; file: string },
  hop: string,
): void {
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

function parseChains(
  raw: unknown,
  engines: EngineEntry[],
  models: ModelEntry[],
  file: string,
): Record<string, string[]> {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new ParseError('"chain" must be a table', file);
  }
  const modelNames = new Set(models.flatMap((m) => [m.id, ...m.aliases]));
  const chains: Record<string, string[]> = {};
  for (const [name, hopsRaw] of Object.entries(raw)) {
    const arr = asArray(hopsRaw);
    if (arr.length === 0) {
      throw new ParseError(`chain "${name}" has no hops`, file);
    }
    chains[name] = arr.map((hopRaw, i) => {
      if (typeof hopRaw !== "string") {
        throw new ParseError(`chain "${name}"[${i}] must be a string`, file);
      }
      const match = HOP_RE.exec(hopRaw);
      const engineSeg = match?.[1];
      const modelSeg = match?.[2];
      if (!(engineSeg && modelSeg)) {
        throw new ParseError(
          `chain "${name}"[${i}] "${hopRaw}" is not a fully-qualified "@/<engine>/<model>" hop`,
          file,
        );
      }
      resolveEngineHalf(engineSeg, { engines, models, file }, hopRaw);
      if (!modelNames.has(modelSeg)) {
        throw new ParseError(
          `chain "${name}"[${i}] "${hopRaw}": model "${modelSeg}" does not exist`,
          file,
        );
      }
      return hopRaw;
    });
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

  const engines = asArray(raw.engine).map((e, i) => parseEngine(e, i, file));
  const models = asArray(raw.model).map((m, i) => parseModel(m, i, file));
  checkNamespaceCollisions(engines, models, file);

  const engineMap = new Map(engines.map((e) => [e.id, e]));
  for (const m of models) {
    validateModelAgainstEngine(m, engineMap, file);
  }
  validateModelsMax(engines, models, file);

  const chains = parseChains(raw.chain, engines, models, file);

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

/**
 * Later layers win. Callers order layers so the floor is passed last.
 * ponytail: a shallow merge, so a nested table replaces wholesale rather than
 * merging key by key. Correct while [engine.args] and [model.args] stay flat;
 * deep-merge only once a spec actually nests one.
 */
export function resolveArgs(...layers: Record<string, unknown>[]): Record<string, unknown> {
  return Object.assign({}, ...layers);
}
