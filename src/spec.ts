/**
 * Loads, validates and resolves an engine spec: the shipped `engines/<id>/spec.toml`,
 * or a `spec_dir` override that replaces it wholesale. See `types.ts` for the
 * shapes and the agentic floor this module enforces on every launch.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, agentCli } from "./agents.ts";
import { asArray, assertKnownKeys, optional, requireString } from "./config.ts";
import { stateDir } from "./paths.ts";
import {
  type AgenticSpec,
  type Artifact,
  argvFromArgs,
  assertNoForbiddenFlags,
  type ContainerSpec,
  type EngineEntry,
  type EngineKind,
  isContainerSpec,
  isRecord,
  KIND_TRAITS,
  type LoadedSpec,
  ParseError,
  type ReadyProbe,
  type Spec,
  type UpstreamTrait,
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
  "init",
  "entrypoint",
  "volume",
  "artifact",
  "ready",
] as const;

/** A spec declares no port: the container side is the image's EXPOSE, the host side is docker's. */
const PORT_KEYS = new Set(["port", "ports", "expose"]);

/** Keys both dialects read. */
const COMMON_KEYS = ["kind", "upstream", "serves", "env", "command", "streaming"] as const;

const AGENTIC_KEYS: ReadonlySet<string> = new Set([...COMMON_KEYS, "agent"]);
const CONTAINER_KEYS: ReadonlySet<string> = new Set([
  ...COMMON_KEYS,
  ...CONTAINER_ONLY_KEYS,
  "images_workflow",
  "images_edit_workflow",
]);
const READY_KEYS: ReadonlySet<string> = new Set(["path", "status", "method", "accept"]);
const ACCEPT_KEYS: ReadonlySet<string> = new Set(["min", "max"]);
const VOLUME_KEYS: ReadonlySet<string> = new Set(["name", "path", "read_only"]);
const ARTIFACT_KEYS: ReadonlySet<string> = new Set(["path", "obtain"]);

export function loadSpec(engine: EngineEntry, opts: SpecLoadOptions): LoadedSpec {
  const overridden = engine.spec_dir !== undefined;
  const specDir = overridden ? (engine.spec_dir as string) : join(opts.enginesRoot, engine.id);
  const file = join(specDir, "spec.toml");

  if (!existsSync(file)) {
    throw new ParseError(`no spec directory for engine "${engine.id}"`, file);
  }
  if (engine.agent_version === "latest" || engine.agent_version === "@latest") {
    throw new ParseError('agent_version must not be "latest" or "@latest"', file);
  }

  const raw = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assertNoPortKey(raw, file);

  const kind = requireString(raw.kind, '"kind"', file);
  let spec: Spec =
    kind === "agentic-cli" ? parseAgentic(raw, file) : parseContainer(raw, file, kind);

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
  // `state_dir` needs no config key: it is the daemon's own writable
  // directory, the same one every engine's state already lives under, so a
  // spec that mounts a door-owned directory names it rather than being
  // configured with a host path an operator could point anywhere.
  const subs: Record<string, string> = {
    spec_dir: specDir,
    bunx: opts.bunx,
    state_dir: stateDir(),
  };
  if (opts.presetIni !== undefined) {
    subs.preset_ini = opts.presetIni;
  }
  if (engine.models_dir !== undefined) {
    subs.models_dir = engine.models_dir;
  }
  if (engine.agent_version !== undefined) {
    subs.agent_version = engine.agent_version;
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
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
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
  if (isRecord(obj)) {
    for (const [k, v] of Object.entries(obj)) {
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

/**
 * Every spec must declare its own trait: a spec-full engine has no other
 * source of truth for how it gets an upstream when a route names none.
 */
function requireUpstreamTrait(raw: Record<string, unknown>, file: string): UpstreamTrait {
  const { upstream } = raw;
  if (upstream !== "self" && upstream !== "optional" && upstream !== "required") {
    throw new ParseError('spec needs "upstream", one of: "self", "optional", "required"', file);
  }
  return upstream;
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
  assertKnownKeys(raw, "spec", AGENTIC_KEYS, file);
  const agentId = requireString(raw.agent, '"agent"', file);
  const agent = agentCli(agentId);
  if (agent === undefined) {
    throw new ParseError(
      `unknown agent "${agentId}"; engined launches one of: ${AGENT_IDS.join(", ")}`,
      file,
    );
  }
  const command = requireStringArray(raw.command, "command", file);
  if (command[0] !== "{bunx}") {
    throw new ParseError(
      "command[0] of an agentic-cli spec must be the {bunx} placeholder engined resolves",
      file,
    );
  }
  // The launch argv is built from scratch in agentic.ts and this array is
  // discarded, so this is the only moment a spec pointing the pin at some
  // other package can be caught at all.
  const [, pkg] = command;
  if (pkg === undefined || !(pkg === agent.pkg || pkg.startsWith(`${agent.pkg}@`))) {
    throw new ParseError(
      `command[1] of an agent "${agent.id}" spec must be the "${agent.pkg}" package, never another`,
      file,
    );
  }
  return {
    kind: "agentic-cli",
    agent: agent.id,
    serves: requireStringArray(raw.serves, "serves", file),
    env: raw.env === undefined ? [] : requireStringArray(raw.env, "env", file),
    command,
    upstream: requireUpstreamTrait(raw, file),
    streaming: raw.streaming === true,
  };
}

function parseContainer(raw: Record<string, unknown>, file: string, kind: string): ContainerSpec {
  if (!(Object.hasOwn(KIND_TRAITS, kind) && KIND_TRAITS[kind as EngineKind].container)) {
    throw new ParseError(`unknown engine kind "${kind}"`, file);
  }
  assertKnownKeys(raw, "spec", CONTAINER_KEYS, file);
  const image = requireString(raw.image, '"image"', file);
  if (raw.obtain !== "pull" && raw.obtain !== "build") {
    throw new ParseError('"obtain" must be "pull" or "build"', file);
  }
  return {
    kind: kind as ContainerSpec["kind"],
    image,
    obtain: raw.obtain,
    serves: requireStringArray(raw.serves, "serves", file),
    env: raw.env === undefined ? [] : requireStringArray(raw.env, "env", file),
    command: requireStringArray(raw.command, "command", file),
    upstream: requireUpstreamTrait(raw, file),
    devices: raw.devices === undefined ? [] : requireStringArray(raw.devices, "devices", file),
    group_add:
      raw.group_add === undefined ? [] : requireStringArray(raw.group_add, "group_add", file),
    init: raw.init === true,
    streaming: raw.streaming === true,
    security_opt:
      raw.security_opt === undefined
        ? []
        : requireStringArray(raw.security_opt, "security_opt", file),
    entrypoint:
      raw.entrypoint === undefined
        ? undefined
        : requireStringArray(raw.entrypoint, "entrypoint", file),
    images_workflow:
      raw.images_workflow === undefined
        ? undefined
        : requireString(raw.images_workflow, '"images_workflow"', file),
    images_edit_workflow:
      raw.images_edit_workflow === undefined
        ? undefined
        : requireString(raw.images_edit_workflow, '"images_edit_workflow"', file),
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
  assertKnownKeys(raw, "[ready]", READY_KEYS, file);
  const path = requireString(raw.path, '[ready] "path"', file);
  if (typeof raw.status !== "number") {
    throw new ParseError('[ready] "status" must be a number', file);
  }
  const probe: ReadyProbe = { path, status: raw.status };
  if (raw.method !== undefined) {
    if (raw.method !== "GET" && raw.method !== "POST") {
      throw new ParseError('[ready] "method" must be "GET" or "POST"', file);
    }
    probe.method = raw.method;
  }
  if (raw.accept !== undefined) {
    if (
      !isRecord(raw.accept) ||
      typeof raw.accept.min !== "number" ||
      typeof raw.accept.max !== "number"
    ) {
      throw new ParseError('[ready.accept] needs numeric "min" and "max"', file);
    }
    assertKnownKeys(raw.accept, "[ready.accept]", ACCEPT_KEYS, file);
    probe.accept = { min: raw.accept.min, max: raw.accept.max };
  }
  return probe;
}

function parseVolumes(raw: unknown, file: string): Volume[] {
  return asArray(raw, "volume", file).map((v) => {
    if (!isRecord(v)) {
      throw new ParseError("malformed [[volume]] entry", file);
    }
    assertKnownKeys(v, "[[volume]]", VOLUME_KEYS, file);
    return {
      name: requireString(v.name, '[[volume]] "name"', file),
      path: requireString(v.path, '[[volume]] "path"', file),
      read_only: optional(v.read_only, "boolean", '[[volume]] "read_only"', file),
    };
  });
}

function parseArtifacts(raw: unknown, file: string): Artifact[] {
  return asArray(raw, "artifact", file).map((a) => {
    if (!isRecord(a)) {
      throw new ParseError("malformed [[artifact]] entry", file);
    }
    assertKnownKeys(a, "[[artifact]]", ARTIFACT_KEYS, file);
    return {
      path: requireString(a.path, '[[artifact]] "path"', file),
      obtain: requireString(a.obtain, '[[artifact]] "obtain"', file),
    };
  });
}

/**
 * Every container kind's own [engine.args]. llama does not come through
 * here at all -- its builder routes them into the preset INI instead, because
 * a CLI flag would override the preset for every model. `buildRunArgs` renders as
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
