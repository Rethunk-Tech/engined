/**
 * Loads, validates and resolves an engine spec: the shipped `engines/<id>/spec.toml`,
 * or a `spec_dir` override that replaces it wholesale. See `types.ts` for the
 * shapes and the agentic floor this module enforces on every launch.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgenticSpec,
  type Artifact,
  argvFromArgs,
  assertNoForbiddenFlags,
  CONTAINER_KINDS,
  type ContainerSpec,
  type EngineEntry,
  isContainerSpec,
  isRecord,
  type LoadedSpec,
  ParseError,
  type ReadyProbe,
  type Spec,
  type Volume,
} from "./types.ts";

export interface SpecLoadOptions {
  /** Root of the shipped `engines/` directory. */
  enginesRoot: string;
  /** Absolute `bunx` path the install script resolved and recorded. */
  bunx: string;
  /** The rendered presets-INI path, when one exists for this engine. */
  presetIni?: string;
}

/** Keys that belong to the container dialect only; fatal on an agentic-cli spec. */
const CONTAINER_ONLY_KEYS = [
  "image",
  "obtain",
  "devices",
  "group_add",
  "security_opt",
  "entrypoint",
  "volume",
  "artifact",
  "ready",
] as const;

/** A spec declares no port: the container side is the image's EXPOSE, the host side is docker's. */
const PORT_KEYS = new Set(["port", "ports", "expose"]);

export function loadSpec(engine: EngineEntry, opts: SpecLoadOptions): LoadedSpec {
  const overridden = engine.spec_dir !== undefined;
  const specDir = overridden ? (engine.spec_dir as string) : join(opts.enginesRoot, engine.id);
  const file = join(specDir, "spec.toml");

  if (!existsSync(file)) {
    throw new ParseError(`no spec directory for engine "${engine.id}"`, file);
  }
  if (engine.claude_version === "latest" || engine.claude_version === "@latest") {
    throw new ParseError('claude_version must not be "latest" or "@latest"', file);
  }

  const raw = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assertNoPortKey(raw, file);

  if (typeof raw.kind !== "string") {
    throw new ParseError('spec has no "kind"', file);
  }
  let spec: Spec =
    raw.kind === "agentic-cli" ? parseAgentic(raw, file) : parseContainer(raw, file, raw.kind);

  const subs = buildSubs(engine, opts, specDir);
  spec = substituteDeep(spec, subs, file);

  assertNoForbiddenFlags(spec.command, file);
  if (isContainerSpec(spec) && spec.entrypoint) {
    assertNoForbiddenFlags(spec.entrypoint, file);
  }

  return { spec, source: specDir };
}

function buildSubs(
  engine: EngineEntry,
  opts: SpecLoadOptions,
  specDir: string,
): Record<string, string> {
  const subs: Record<string, string> = { spec_dir: specDir, bunx: opts.bunx };
  if (opts.presetIni !== undefined) {
    subs.preset_ini = opts.presetIni;
  }
  if (engine.models_dir !== undefined) {
    subs.models_dir = engine.models_dir;
  }
  if (engine.claude_version !== undefined) {
    subs.claude_version = engine.claude_version;
  }
  if (engine.models_max !== undefined) {
    subs.models_max = String(engine.models_max);
  }
  return subs;
}

function substitute(s: string, subs: Record<string, string>, file: string): string {
  return s.replace(/\{([a-z_]+)\}/g, (whole, key: string) => {
    const v = subs[key];
    if (v === undefined) {
      throw new ParseError(`unresolved placeholder ${whole}`, file);
    }
    return v;
  });
}

/**
 * Substitutes every string value anywhere in a parsed spec, so no field can
 * carry an unresolved placeholder past parse. Mirrors `assertNoPortKey`'s
 * traversal deliberately: a hand-list of which fields to substitute leaves
 * whatever it forgets (image, obtain, serves, env, devices, artifact.path,
 * ...) silently unscanned.
 */
function substituteDeep<T>(value: T, subs: Record<string, string>, file: string): T {
  if (typeof value === "string") {
    return substitute(value, subs, file) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteDeep(item, subs, file)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, subs, file);
    }
    return out as T;
  }
  return value;
}

function assertNoPortKey(obj: unknown, file: string): void {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      assertNoPortKey(item, file);
    }
    return;
  }
  if (obj !== null && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (PORT_KEYS.has(k)) {
        throw new ParseError(
          `"${k}" is not a spec field: the container side is the image's EXPOSE, the host side is docker's`,
          file,
        );
      }
      assertNoPortKey(v, file);
    }
  }
}

function requireStringArray(v: unknown, field: string, file: string): string[] {
  if (!(Array.isArray(v) && v.every((x) => typeof x === "string"))) {
    throw new ParseError(`"${field}" must be an array of strings`, file);
  }
  return v as string[];
}

function parseAgentic(raw: Record<string, unknown>, file: string): AgenticSpec {
  for (const key of CONTAINER_ONLY_KEYS) {
    if (key in raw) {
      throw new ParseError(
        `"${key}" is a container-only key, invalid on an agentic-cli spec`,
        file,
      );
    }
  }
  const command = requireStringArray(raw.command, "command", file);
  if (command[0] !== "{bunx}") {
    throw new ParseError(
      "command[0] of an agentic-cli spec must be the {bunx} placeholder engined resolves",
      file,
    );
  }
  return {
    kind: "agentic-cli",
    serves: requireStringArray(raw.serves, "serves", file),
    env: raw.env === undefined ? [] : requireStringArray(raw.env, "env", file),
    command,
  };
}

function parseContainer(raw: Record<string, unknown>, file: string, kind: string): ContainerSpec {
  if (!(CONTAINER_KINDS as ReadonlySet<string>).has(kind)) {
    throw new ParseError(`unknown engine kind "${kind}"`, file);
  }
  if (typeof raw.image !== "string") {
    throw new ParseError('container spec needs "image"', file);
  }
  if (raw.obtain !== "pull" && raw.obtain !== "build") {
    throw new ParseError('"obtain" must be "pull" or "build"', file);
  }
  return {
    kind: kind as ContainerSpec["kind"],
    image: raw.image,
    obtain: raw.obtain,
    serves: requireStringArray(raw.serves, "serves", file),
    env: raw.env === undefined ? [] : requireStringArray(raw.env, "env", file),
    command: requireStringArray(raw.command, "command", file),
    devices: raw.devices === undefined ? [] : requireStringArray(raw.devices, "devices", file),
    group_add:
      raw.group_add === undefined ? [] : requireStringArray(raw.group_add, "group_add", file),
    security_opt:
      raw.security_opt === undefined
        ? []
        : requireStringArray(raw.security_opt, "security_opt", file),
    entrypoint:
      raw.entrypoint === undefined
        ? undefined
        : requireStringArray(raw.entrypoint, "entrypoint", file),
    volumes: parseVolumes(raw.volume, file),
    artifacts: parseArtifacts(raw.artifact, file),
    ready: parseReady(raw.ready, file),
  };
}

function parseReady(raw: unknown, file: string): ReadyProbe {
  if (!isRecord(raw)) {
    throw new ParseError(
      "container spec has no readiness probe: a TCP connect is not readiness",
      file,
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || typeof r.status !== "number") {
    throw new ParseError('[ready] needs a string "path" and numeric "status"', file);
  }
  const probe: ReadyProbe = { path: r.path, status: r.status };
  if (r.method !== undefined) {
    if (r.method !== "GET" && r.method !== "POST") {
      throw new ParseError('[ready] "method" must be "GET" or "POST"', file);
    }
    probe.method = r.method;
  }
  if (r.accept !== undefined) {
    const accept = r.accept as Record<string, unknown>;
    if (typeof accept.min !== "number" || typeof accept.max !== "number") {
      throw new ParseError('[ready.accept] needs numeric "min" and "max"', file);
    }
    probe.accept = { min: accept.min, max: accept.max };
  }
  return probe;
}

function parseVolumes(raw: unknown, file: string): Volume[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ParseError('"volume" must be an array of [[volume]] tables', file);
  }
  return raw.map((v) => {
    if (!isRecord(v)) {
      throw new ParseError("malformed [[volume]] entry", file);
    }
    const o = v as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.path !== "string") {
      throw new ParseError('[[volume]] needs a string "name" and "path"', file);
    }
    if (o.read_only !== undefined && typeof o.read_only !== "boolean") {
      throw new ParseError('[[volume]] "read_only" must be a boolean', file);
    }
    return { name: o.name, path: o.path, read_only: o.read_only as boolean | undefined };
  });
}

function parseArtifacts(raw: unknown, file: string): Artifact[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ParseError('"artifact" must be an array of [[artifact]] tables', file);
  }
  return raw.map((a) => {
    if (!isRecord(a)) {
      throw new ParseError("malformed [[artifact]] entry", file);
    }
    const o = a as Record<string, unknown>;
    if (typeof o.path !== "string" || typeof o.obtain !== "string") {
      throw new ParseError('[[artifact]] needs a string "path" and "obtain"', file);
    }
    return { path: o.path, obtain: o.obtain };
  });
}

/**
 * Every container kind's own [engine.args]. local-llama's builder appends its
 * own; every other kind, comfy included, comes through here. `buildRunArgs` renders as
 * `image, ...entrypoint, ...command`, so an empty `command` means "run the
 * image's own baked-in CMD unmodified" (chatterbox/kokoro's real shape: it
 * is already correct, nothing to extend) and appending flags to it does not
 * extend that CMD, it REPLACES "use the image's own" with "run these flags
 * as the command" -- silently corrupting the launch, not merely leaving the
 * args unused. That is rejected here instead: an operator who sets
 * `[engine.args]` gets its effect or an error, the same contract
 * config.ts's own closed key sets hold one layer up.
 */
export function applyEngineArgs(engine: EngineEntry, spec: ContainerSpec): ContainerSpec {
  const argv = argvFromArgs(engine.args);
  if (argv.length === 0) {
    return spec;
  }
  if (spec.command.length === 0) {
    throw new Error(
      `engine "${engine.id}": [engine.args] is set, but this engine's command is image-defined (empty) -- appending flags would replace the image's own CMD, not extend it`,
    );
  }
  return { ...spec, command: [...spec.command, ...argv] };
}
