import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { ObservedVersion } from "./agentic.ts";
import type { AgentTarget } from "./agents.ts";
import { buildRunArgs, DockerLifecycle, type Probe, type RuntimeStatus } from "./docker.ts";
import {
  type AgenticProbeRunner,
  EngineBusyError,
  EngineRegistry,
  type QueueSnapshot,
  type RegistryOptions,
} from "./engines.ts";
import type { Exec, ExecResult } from "./exec.ts";
import { stateDir } from "./paths.ts";
import { loadSpec } from "./spec.ts";
import {
  BUNX,
  buildExec,
  clearVerifiedVersion,
  config,
  containerRunning,
  ENGINES_ROOT,
  engine,
  makeTestRoot,
  route,
  upstream,
  writeEngineSpec,
} from "./test-support.ts";
import {
  type Config,
  type EngineEntry,
  type EngineStatus,
  FatalError,
  isContainerSpec,
  type RunnableContainerSpec,
} from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-engines-test-");

/**
 * Redirects `stateDir()` under `TEST_ROOT` for whatever the caller does next,
 * returning a restore function for its `finally`. Needed wherever the code
 * under test resolves a path via `stateDir()` (paths.ts) directly rather than
 * through an injectable option -- `llama`'s preset path is one such
 * case, and writes there land on the real operator's state directory
 * otherwise, not a sandbox.
 */
function redirectStateHome(): () => void {
  const stateHome = mkdtempSync(join(TEST_ROOT, "engined-state-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  return () => {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
  };
}

function newEnginesRoot(): string {
  return mkdtempSync(join(TEST_ROOT, "engined-engines-"));
}

const PULLED_CONTAINER = `
kind = "openai-http"
upstream = "self"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/chat/completions"]
command = ["--model", "x"]

[ready]
path = "/health"
status = 200
`;

const BUILT_CONTAINER = `
kind = "tts"
upstream = "self"
image = "engined/kokoro:local"
obtain = "build"
serves = ["/openai/v1/audio/speech"]
command = ["--serve"]

[ready]
path = "/health"
status = 200

[[artifact]]
path = "/models/kokoro.bin"
obtain = "docker run --rm -v engined-kokoro-models:/models curlimages/curl -fL -o /models/kokoro.bin https://example.com/kokoro.bin"
`;

const AGENTIC = `
kind = "agentic-cli"
upstream = "optional"
agent = "claude"
serves = ["/openai/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code@{agent_version}", "-p"]
`;

/** No `{agent_version}` placeholder: loads even when the engine configures none, unlike the shipped spec. */
const AGENTIC_NO_VERSION_PLACEHOLDER = `
kind = "agentic-cli"
upstream = "optional"
agent = "claude"
serves = ["/openai/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code", "-p"]
`;

/** Mirrors engines/chatterbox-multi and engines/kokoro's real shape: the image's own CMD is already correct, so command is deliberately empty. */
const TTS_EMPTY_COMMAND = `
kind = "tts"
upstream = "self"
image = "engined/faketts:local"
obtain = "build"
serves = ["/openai/v1/audio/speech"]
command = []

[ready]
path = "/health"
status = 200
`;

/**
 * The one artifact shape no host `stat` can answer: a docker-managed named
 * volume (`name` is not an absolute path), so the check is a container of its
 * own -- a second `docker run` alongside the detached start.
 */
const STT_VOLUME_ARTIFACT = `
kind = "stt"
upstream = "self"
image = "engined/fakestt:local"
obtain = "build"
serves = ["/openai/v1/audio/transcriptions"]
command = ["--host", "0.0.0.0"]

[ready]
path = "/health"
status = 200

[[volume]]
name = "engined-fakestt-models"
path = "/models"

[[artifact]]
path = "/models/fake.bin"
obtain = "curl -fL -o /models/fake.bin https://example.com/fake.bin"
`;

/** Mirrors engines/whisper's real shape: a real command that flags can extend. */
const STT_REAL_COMMAND = `
kind = "stt"
upstream = "self"
image = "engined/fakestt:local"
obtain = "build"
serves = ["/openai/v1/audio/transcriptions"]
command = ["--host", "0.0.0.0"]

[ready]
path = "/health"
status = 200
`;

/** Image present with one exposed port, no artifacts to fail: the tests that only need a registry to exist. */
function okExec(args: readonly string[]): Promise<ExecResult> {
  const result: ExecResult =
    args[0] === "image" && args[1] === "inspect"
      ? { stdout: '[{"Config":{"ExposedPorts":{"8000/tcp":{}}}}]', stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 };
  return Promise.resolve(result);
}

/** `docker image inspect` fails for everything, as it does with nothing pulled. */
function noImageExec(args: readonly string[]): Promise<ExecResult> {
  const result: ExecResult =
    args[0] === "image" && args[1] === "inspect"
      ? { stdout: "", stderr: "no such image", exitCode: 1 }
      : { stdout: "", stderr: "", exitCode: 0 };
  return Promise.resolve(result);
}

/** Image present, port exposed, but the one declared artifact is missing. */
function missingArtifactExec(args: readonly string[]): Promise<ExecResult> {
  let result: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
  if (args[0] === "image" && args[1] === "inspect") {
    result = { stdout: '[{"Config":{"ExposedPorts":{"8000/tcp":{}}}}]', stderr: "", exitCode: 0 };
  } else if (args[0] === "run") {
    result = { stdout: "", stderr: "", exitCode: 1 };
  }
  return Promise.resolve(result);
}

const OK_EXEC: Exec = okExec;
const NO_IMAGE_EXEC: Exec = noImageExec;
const MISSING_ARTIFACT_EXEC: Exec = missingArtifactExec;

function registry(
  cfg: Config,
  enginesRoot: string,
  extra: Partial<RegistryOptions> = {},
): EngineRegistry {
  return new EngineRegistry(cfg, { enginesRoot, bunx: BUNX, exec: OK_EXEC, ...extra });
}

/** A registry over one "llama" engine backed by a real spec on disk, per the digest-pinned container fixture. */
function setupLlama(extra: Partial<RegistryOptions> = {}): { root: string; reg: EngineRegistry } {
  const root = newEnginesRoot();
  writeEngineSpec(root, "llama", PULLED_CONTAINER);
  return { root, reg: registry(config({ engines: [engine({ id: "llama" })] }), root, extra) };
}

/** A registry over one "kokoro" engine backed by a real build-obtained spec on disk. */
function setupKokoro(exec: Exec): { root: string; reg: EngineRegistry } {
  const root = newEnginesRoot();
  writeEngineSpec(root, "kokoro", BUILT_CONTAINER);
  return { root, reg: registry(config({ engines: [engine({ id: "kokoro" })] }), root, { exec }) };
}

const RX_DISABLED_START = /is disabled in config/;
const RX_NO_ENDPOINT = /engine "img".*serves no endpoint to ask it through/;
const RX_WIRE_MISMATCH = /wire "openai".*speaks "anthropic"/;
const RX_IS_SELF = /is "self"/;
const RX_MISSING_ROLE = /missing required "role"/;
const RX_MISSING_FILENAME = /missing required "filename"/;

/** Records what `reload` asks to be torn down; a disabling reload must ask. */
class RemovalSpy extends DockerLifecycle {
  readonly removed: string[] = [];
  override removeEngine(id: string): Promise<void> {
    this.removed.push(id);
    return super.removeEngine(id);
  }
}

describe("disabled engines", () => {
  test("are reported as disabled and unavailable, are never probed, and refuse to start", async () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "llama", PULLED_CONTAINER);
    const execLog: string[][] = [];
    const reg = registry(config({ engines: [engine({ id: "llama", disabled: true })] }), root, {
      exec: (args) => {
        execLog.push([...args]);
        return OK_EXEC(args);
      },
    });

    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.disabled).toBe(true);
    expect(listed?.state).toBe("unavailable");
    // Its real spec, not a guess: the engine is off, not unknown.
    expect(listed?.kind).toBe("openai-http");
    expect(listed?.serves).toEqual(["/openai/v1/chat/completions"]);
    expect(listed?.fix).toBe('set "disable = false" on engine "llama" in config.toml');
    // list() probes docker for every engine it does not short-circuit.
    expect(execLog).toEqual([]);

    expect(reg.get("llama")?.disabled).toBe(true);
    await expect(reg.start("llama")).rejects.toThrow(RX_DISABLED_START);
    expect(execLog).toEqual([]);
  });

  test("a route shape that would fail the boot is not checked on a disabled engine", () => {
    // The escape hatch has to reach the check that refuses the boot: an
    // engine nothing may start or route to cannot be why the daemon is down.
    const root = newEnginesRoot();
    writeEngineSpec(root, "llama-like", PULLED_CONTAINER);
    const reg = registry(
      config({
        engines: [engine({ id: "llama-like", models_dir: "/data/gguf", disabled: true })],
        routes: [
          route({ engine: "llama-like", upstream: "local", model: "x", filename: "x.gguf" }),
        ],
      }),
      root,
    );
    expect(reg.get("llama-like")?.disabled).toBe(true);
  });

  test("a reload that disables an engine tears its container down like a removal", () => {
    // The entry survives a disabling reload, so the removal that a dropped
    // engine gets for free has to be asked for -- this is that ask.
    const removed = removedByReload(
      config({ engines: [engine({ id: "llama" })] }),
      config({ engines: [engine({ id: "llama", disabled: true })] }),
    );
    expect(removed).toEqual(["llama"]);
  });
});

/** Records the idle-stop each status probe is handed -- what an adopted orphan's countdown is armed from. */
class ProbeSpy extends DockerLifecycle {
  readonly idleStops: (number | undefined)[] = [];
  override probe(
    id: string,
    spec: RunnableContainerSpec,
    specSource?: string,
    idleStopSeconds?: number,
  ): Promise<RuntimeStatus> {
    this.idleStops.push(idleStopSeconds);
    return super.probe(id, spec, specSource, idleStopSeconds);
  }
}

test("a status probe carries the engine's own idle-stop, so an adopted orphan counts down on the configured one", async () => {
  const root = newEnginesRoot();
  writeEngineSpec(root, "llama", PULLED_CONTAINER);
  const lifecycle = new ProbeSpy(OK_EXEC, READY_PROBE);
  const reg = registry(
    config({ engines: [engine({ id: "llama", idle_stop_seconds: 42 })] }),
    root,
    { lifecycle },
  );

  await reg.list();

  expect(lifecycle.idleStops).toEqual([42]);
});

/** Every teardown a reload asks for fails, the way an unreachable docker daemon fails one. */
class FailingRemoval extends DockerLifecycle {
  override removeEngine(): Promise<void> {
    return Promise.reject(new Error("docker daemon unreachable"));
  }
}

test("a reload teardown that fails is reported, not swallowed", async () => {
  const root = newEnginesRoot();
  writeEngineSpec(root, "llama", PULLED_CONTAINER);
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    registry(config({ engines: [engine({ id: "llama" })] }), root, {
      lifecycle: new FailingRemoval(OK_EXEC),
    }).reload(config({ engines: [] }));
    // The teardown runs in the background: `reload` is synchronous.
    await Promise.resolve();
  } finally {
    process.stderr.write = realWrite;
  }

  expect(written.join("")).toContain("llama");
  expect(written.join("")).toContain("docker daemon unreachable");
});

/** Builds a registry over a pulled `llama` from `before`, reloads it with `after`, and reports what was torn down. */
function removedByReload(before: Config, after: Config): string[] {
  const root = newEnginesRoot();
  writeEngineSpec(root, "llama", PULLED_CONTAINER);
  const lifecycle = new RemovalSpy(OK_EXEC);
  registry(before, root, { lifecycle }).reload(after);
  return lifecycle.removed;
}

describe("reloading an engine's route binding", () => {
  test("a reload that repoints an engine's route away from local tears its container down without changing its id", () => {
    // The id diff alone would miss this: "llama" survives into the new
    // config unchanged, and only its route's own upstream moved.
    const removed = removedByReload(
      config({
        engines: [engine({ id: "llama" })],
        upstreams: [upstream({ id: "peer", egress: "lan" })],
        routes: [route({ engine: "llama", model: "m", upstream: "local" })],
      }),
      config({
        engines: [engine({ id: "llama" })],
        upstreams: [upstream({ id: "peer", egress: "lan" })],
        routes: [route({ engine: "llama", model: "m", upstream: "peer" })],
      }),
    );
    expect(removed).toEqual(["llama"]);
  });

  test("a reload that keeps an engine's local binding does not tear its container down", () => {
    const removed = removedByReload(
      config({
        engines: [engine({ id: "llama" })],
        routes: [route({ engine: "llama", model: "m", upstream: "local" })],
      }),
      config({
        engines: [engine({ id: "llama", idle_stop_seconds: 42 })],
        routes: [route({ engine: "llama", model: "m", upstream: "local" })],
      }),
    );
    expect(removed).toEqual([]);
  });

  // The bindings-only failure this delivery exists to avoid: an engine with
  // no routes at all (comfy, sometimes) has no binding either way, so a
  // rule that merged the id-diff and binding checks into one would stop
  // managing it silently the moment it had zero routes -- still typechecking,
  // still constructing, and never torn down or reported missing.
  test("an engine with no routes at all has no binding to lose, and an unrelated reload does not spuriously tear it down", () => {
    const removed = removedByReload(
      config({ engines: [engine({ id: "llama" })], routes: [] }),
      config({ engines: [engine({ id: "llama", idle_stop_seconds: 42 })], routes: [] }),
    );
    expect(removed).toEqual([]);
  });
});

describe("unavailable engines", () => {
  test("missing image is unavailable and names the pull command for a digest-pinned image, and never starts a container", async () => {
    const runLog: string[][] = [];
    const trackingExec: Exec = (args) => {
      if (args[0] === "run") {
        runLog.push([...args]);
      }
      return noImageExec(args);
    };
    const { reg } = setupLlama({ exec: trackingExec });
    // get() is the sync accessor and does not probe docker cold; list() does.
    expect(reg.get("llama")?.state).toBe("installed");
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toBe("docker pull ghcr.io/example/llama@sha256:aaaa");
    expect(runLog.length).toBe(0);
  });

  test("missing image with a Dockerfile in its spec dir names a runnable docker build", async () => {
    const { root, reg } = setupKokoro(NO_IMAGE_EXEC);
    writeFileSync(join(root, "kokoro", "Dockerfile"), "FROM scratch\n");
    const listed = (await reg.list()).engines.find((e) => e.id === "kokoro");
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toBe(
      `docker build -t engined/kokoro:local -f ${join(root, "kokoro", "Dockerfile")} ${join(root, "kokoro")}`,
    );
  });

  test("missing image with NO Dockerfile in its spec dir does not invent a build command", async () => {
    // llama's real shape: obtain = "build", no Dockerfile shipped here
    // because the image is built from a different repository entirely.
    const { reg } = setupKokoro(NO_IMAGE_EXEC);
    const listed = (await reg.list()).engines.find((e) => e.id === "kokoro");
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).not.toContain("docker build");
    expect(listed?.fix).toContain("engined/kokoro:local");
  });

  test("missing artifact is unavailable and names the command that supplies it, via start()", async () => {
    const { reg } = setupKokoro(MISSING_ARTIFACT_EXEC);
    const status = await reg.start("kokoro");
    expect(status.state).toBe("unavailable");
    expect(status.fix).toContain("curlimages/curl");
  });
});

/**
 * Discovering this by trying costs a 502 on every streamed request, and the
 * alternative -- a hardcoded engine list per consumer -- goes stale the moment
 * engined gains an engine. So it is reported where the engines are defined.
 */
describe("streaming capability", () => {
  function ttsSpec(streaming: boolean): string {
    return `
kind = "tts"
upstream = "self"
image = "ghcr.io/example/tts@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/audio/speech"]
command = []
${streaming ? "streaming = true" : ""}

[ready]
path = "/health"
status = 200
`;
  }

  test("reported per tts engine, and a real false on a kind with no chunk contract to declare", async () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "chunker", ttsSpec(true));
    writeEngineSpec(root, "blocker", ttsSpec(false));
    writeEngineSpec(root, "llama", PULLED_CONTAINER);
    const reg = registry(
      config({
        engines: [engine({ id: "chunker" }), engine({ id: "blocker" }), engine({ id: "llama" })],
      }),
      root,
    );

    const listed = await reg.list();
    const streamingOf = (id: string) => listed.engines.find((e) => e.id === id)?.streaming;
    expect(streamingOf("chunker")).toBe(true);
    expect(streamingOf("blocker")).toBe(false);
    // An openai-http engine has no /openai/v1/audio/speech to stream on,
    // and now that every kind can answer the question, its truthful answer
    // is a real `false` rather than an `undefined` that reads as "unknown".
    expect(streamingOf("llama")).toBe(false);
  });
});

describe("installed engines", () => {
  test("an engine merely stopped is installed, never reported as broken, and carries no container address", async () => {
    const { reg } = setupLlama();
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.state).toBe("installed");
    expect(listed).not.toHaveProperty("private_url");
    expect(listed?.fix).toBeUndefined();
  });

  test("neither get() nor list() ever carries a container address, before any start or after", async () => {
    const lifecycle = new DockerLifecycle(OK_EXEC);
    const { reg } = setupLlama({ lifecycle });
    expect(reg.get("llama")).not.toHaveProperty("private_url");
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed).not.toHaveProperty("private_url");
  });
});

describe("a route's capability fields reach GET /engined/v1/engines", () => {
  test("one entry per model-bearing route, a disabled route excluded, and no entry for the engine when none of its routes name a model or a field", async () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "llama", PULLED_CONTAINER);
    const reg = registry(
      config({
        engines: [engine({ id: "llama" })],
        routes: [
          route({
            engine: "llama",
            model: "ornith",
            upstream: "local",
            input: ["text"],
            output: ["text"],
            context_in: 8192,
          }),
          route({ engine: "llama", model: "sonnet-5", upstream: "local", output: ["text"] }),
          route({
            engine: "llama",
            model: "off",
            upstream: "local",
            output: ["text"],
            disabled: true,
          }),
        ],
      }),
      root,
    );

    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.capabilities).toMatchObject([
      { model: "ornith", input: ["text"], output: ["text"], context_in: 8192 },
      { model: "sonnet-5", output: ["text"] },
    ]);
    // A roleless route serves whatever its engine serves, per entry.
    const engineServes = listed?.serves ?? [];
    expect(listed?.capabilities?.map((c) => c.serves)).toEqual([engineServes, engineServes]);
  });

  test("an engine with no model-bearing or capability-declaring routes reports no capabilities at all", async () => {
    const { reg } = setupLlama();
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.capabilities).toBeUndefined();
  });
});

/**
 * A capability is not a served endpoint: `serves` says what the door
 * answers, and a route may declare capability fields on an engine whose
 * spec serves nothing at all to ask them through. Checked at registry
 * construction, the same tier as the wire and self-upstream checks above --
 * `serves` comes from the loaded spec, which is not known until here.
 */
describe("a declared capability whose endpoint is unserved fails at startup", () => {
  test("a route declaring a capability on a spec-less engine with an empty serves list fails, naming the engine and its kind", () => {
    const cfg = config({
      engines: [engine({ id: "img", kind: "comfy" })],
      routes: [route({ engine: "img", model: undefined, upstream: "local", output: ["image"] })],
    });
    expect(() => registry(cfg, newEnginesRoot())).toThrow(FatalError);
    expect(() => registry(cfg, newEnginesRoot())).toThrow(RX_NO_ENDPOINT);
  });

  test("the same engine with no capability-declaring route constructs clean", () => {
    const cfg = config({
      engines: [engine({ id: "img", kind: "comfy" })],
      routes: [route({ engine: "img", model: undefined, upstream: "local" })],
    });
    expect(() => registry(cfg, newEnginesRoot())).not.toThrow();
  });
});

function trackingRunner(outcome: { ok: boolean; failedProbe?: string }): {
  runner: AgenticProbeRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: AgenticProbeRunner = (version) => {
    calls.push(version);
    return Promise.resolve(outcome);
  };
  return { runner, calls };
}

/** A spec-less engine (declares `kind` in config) with no upstream secret gate any more -- that lives on the upstream table now, not wired into status reporting this phase. */
function specLessProxyEngine(id: string): EngineEntry {
  return engine({ id, kind: "stt" });
}

describe("spec-less engines: no secret gate, just an optimistic installed", () => {
  test("get() and list() both report installed with no keyring round trip at all", async () => {
    const id = "spec-less-proxy";
    const reg = registry(config({ engines: [specLessProxyEngine(id)] }), newEnginesRoot());
    expect(reg.get(id)?.state).toBe("installed");
    expect(reg.get(id)).not.toHaveProperty("private_url");
    const listed = (await reg.list()).engines.find((e) => e.id === id);
    expect(listed?.state).toBe("installed");
    expect(listed).not.toHaveProperty("private_url");
  });

  test("a spec-less agentic-cli engine has no built-in launch to fall back to, and refuses at construction", () => {
    expect(
      () =>
        new EngineRegistry(config({ engines: [engine({ id: "no-spec", kind: "agentic-cli" })] }), {
          enginesRoot: newEnginesRoot(),
          bunx: BUNX,
        }),
    ).toThrow(FatalError);
  });
});

/**
 * Which shape an engine speaks comes from its agent, and the agent id comes
 * from the spec -- specs load after `loadConfig()`, so a wrong pairing can
 * only be caught here, at registry construction, never as a `config.test.ts`
 * `ParseError`.
 */
describe("an agent's wire is checked against its route's upstream at registry construction", () => {
  test("claude (anthropic) routed at an openai-wire upstream fails at startup, naming both wires", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "claude", AGENTIC);
    const cfg = config({
      engines: [agenticEngine("claude", "1.0.0")],
      upstreams: [upstream({ id: "hosted", wire: "openai", egress: "remote" })],
      routes: [route({ engine: "claude", model: "sonnet", upstream: "hosted" })],
    });
    expect(() => registry(cfg, root)).toThrow(FatalError);
    expect(() => registry(cfg, root)).toThrow(RX_WIRE_MISMATCH);
  });

  test("claude routed at a matching anthropic-wire upstream constructs clean", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "claude", AGENTIC);
    const cfg = config({
      engines: [agenticEngine("claude", "1.0.0")],
      upstreams: [upstream({ id: "hosted", wire: "anthropic", egress: "remote" })],
      routes: [route({ engine: "claude", model: "sonnet", upstream: "hosted" })],
    });
    expect(() => registry(cfg, root)).not.toThrow();
  });

  test("an ambient route (no upstream) has nothing to mismatch against", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "claude", AGENTIC);
    const cfg = config({
      engines: [agenticEngine("claude", "1.0.0")],
      routes: [route({ engine: "claude", model: "sonnet", upstream: null })],
    });
    expect(() => registry(cfg, root)).not.toThrow();
  });
});

/**
 * A `self`-trait engine has no LLM-completions wire of its own, so the only
 * upstream it can validly proxy to besides `local` is a peer's own `local`
 * -- never a `wire`-declaring, and therefore always-foreign, provider.
 */
describe("a self-trait engine may proxy to a peer, never to a wire-shaped provider", () => {
  test("a self engine's route naming a wire-declaring upstream fails at startup", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "voice", TTS_EMPTY_COMMAND);
    const cfg = config({
      engines: [engine({ id: "voice" })],
      upstreams: [upstream({ id: "openai", wire: "openai", egress: "remote" })],
      routes: [route({ engine: "voice", model: undefined, upstream: "openai" })],
    });
    expect(() => registry(cfg, root)).toThrow(FatalError);
    expect(() => registry(cfg, root)).toThrow(RX_IS_SELF);
  });

  test("a self engine's route naming a wire-less peer upstream constructs clean -- bastet kokoro voice1, proxied", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "voice", TTS_EMPTY_COMMAND);
    const cfg = config({
      engines: [engine({ id: "voice" })],
      upstreams: [upstream({ id: "voice1", egress: "lan" })],
      routes: [route({ engine: "voice", model: undefined, upstream: "voice1" })],
    });
    expect(() => registry(cfg, root)).not.toThrow();
  });
});

function agenticEngine(id: string, version: string): EngineEntry {
  return engine({ id, agent_version: version });
}

describe("agentic engines: unproved by default", () => {
  test("no agent_version configured is unavailable, naming the engine", async () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "agentic-verify-noversion", AGENTIC_NO_VERSION_PLACEHOLDER);
    const reg = registry(config({ engines: [engine({ id: "agentic-verify-noversion" })] }), root);
    const listed = (await reg.list()).engines.find((e) => e.id === "agentic-verify-noversion");
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toContain("agent_version");
  });

  test("an unproved pin with no probe runner injected is unavailable, never installed on faith", async () => {
    const id = "agentic-verify-unconfigured";
    clearVerifiedVersion(id);
    const root = newEnginesRoot();
    writeEngineSpec(root, id, AGENTIC);
    const reg = registry(config({ engines: [agenticEngine(id, "1.0.0")] }), root);
    const listed = (await reg.list()).engines.find((e) => e.id === id);
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toContain("1.0.0");
  });
});

describe("agentic engines: the verified_version gate", () => {
  test("clearing the recorded version re-verifies: a failing probe stays unavailable, naming the probe and the version -- no real spawn occurs", async () => {
    const id = "agentic-verify-fail";
    clearVerifiedVersion(id);
    const root = newEnginesRoot();
    writeEngineSpec(root, id, AGENTIC);
    const calls: string[] = [];
    const failingRunner: AgenticProbeRunner = (version) => {
      calls.push(version);
      return Promise.resolve({ ok: false, failedProbe: "byte-identical" });
    };
    const reg = registry(config({ engines: [agenticEngine(id, "2.0.0")] }), root, {
      agenticProbeRunner: failingRunner,
    });

    const listed = (await reg.list()).engines.find((e) => e.id === id);

    expect(calls).toEqual(["2.0.0"]);
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toContain("byte-identical");
    expect(listed?.fix).toContain("2.0.0");
    clearVerifiedVersion(id);
  });

  test("both probes passing yields installed, persists the proved version, and a later list skips the runner -- no real spawn occurs", async () => {
    const id = "agentic-verify-pass";
    clearVerifiedVersion(id);
    const root = newEnginesRoot();
    writeEngineSpec(root, id, AGENTIC);
    const calls: string[] = [];
    const passingRunner: AgenticProbeRunner = (version) => {
      calls.push(version);
      return Promise.resolve({ ok: true });
    };
    const reg = registry(config({ engines: [agenticEngine(id, "3.0.0")] }), root, {
      agenticProbeRunner: passingRunner,
    });

    const first = (await reg.list()).engines.find((e) => e.id === id);
    expect(first?.state).toBe("installed");
    expect(calls).toHaveLength(1);

    // A fresh registry against the same state directory sees the proved
    // version and never invokes the runner again -- the pin has not moved.
    const reg2 = registry(config({ engines: [agenticEngine(id, "3.0.0")] }), root, {
      agenticProbeRunner: passingRunner,
    });
    const second = (await reg2.list()).engines.find((e) => e.id === id);
    expect(second?.state).toBe("installed");
    expect(calls).toHaveLength(1);

    clearVerifiedVersion(id);
  });
});

describe("agentic engines: the round-trip probe target follows the route's own egress", () => {
  test("a route naming the local upstream hands the runner a doorUrl+model to dial; an ambient one hands it nothing", async () => {
    const localId = "agentic-verify-roundtrip-local";
    const ambientId = "agentic-verify-roundtrip-ambient";
    clearVerifiedVersion(localId);
    clearVerifiedVersion(ambientId);
    const root = newEnginesRoot();
    writeEngineSpec(root, localId, AGENTIC);
    writeEngineSpec(root, ambientId, AGENTIC);
    const calls: Array<AgentTarget | undefined> = [];
    const runner: AgenticProbeRunner = (_version, _agent, roundTrip) => {
      calls.push(roundTrip);
      return Promise.resolve({ ok: true });
    };
    const cfg = config({
      listen_port: 39_200,
      engines: [agenticEngine(localId, "1.0.0"), agenticEngine(ambientId, "1.0.0")],
      // AGENTIC's fixture agent is "claude" (anthropic wire) regardless of
      // engine id, so "local" needs a matching wire here or registry
      // construction's own wire check refuses the pairing before this
      // test ever reaches the probe it is actually about.
      upstreams: [upstream({ id: "local", wire: "anthropic" })],
      routes: [
        route({ engine: localId, model: "code", upstream: "local" }),
        route({ engine: ambientId, model: "sonnet-5", upstream: null }),
      ],
    });
    const reg = registry(cfg, root, { agenticProbeRunner: runner });

    await reg.list();

    // "code" is only ever the local route's model, so the target below can only be localId's.
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ baseUrl: "http://127.0.0.1:39200/openai/v1", model: "code" });
    // A billed/remote route (claude's ambient shape here) never gets a
    // dial target -- a status poll must never pay for one.
    expect(calls).toContain(undefined);

    clearVerifiedVersion(localId);
    clearVerifiedVersion(ambientId);
  });
});

/** Always resolves to the given version, real subprocess never touched -- for a hermetic stand-in of a self-updating binary's `--version`. */
function fixedObservedVersion(
  version: string,
): (agent: string, configuredVersion: string) => Promise<{ ok: true; version: string }> {
  return () => Promise.resolve({ ok: true, version });
}

/** A just-cleared agentic pin at "1.0.0" with its spec written, plus a passing probe runner and its call log. */
function freshAgenticPin(id: string): {
  root: string;
  passingRunner: AgenticProbeRunner;
  calls: string[];
} {
  clearVerifiedVersion(id);
  const root = newEnginesRoot();
  writeEngineSpec(root, id, AGENTIC);
  const { runner: passingRunner, calls } = trackingRunner({ ok: true });
  return { root, passingRunner, calls };
}

/**
 * Proves "1.0.0" for `id` exactly as any ordinary first proof would, then
 * builds a second registry over the same state whose binary now reports
 * "1.0.1" -- readVerifiedVersion still says "1.0.0", so this is a real
 * mismatch -- with whatever probe runner (or none) the caller wires in.
 */
async function proveThenDrift(
  id: string,
  driftRunner: AgenticProbeRunner | undefined,
): Promise<{
  first: EngineStatus | undefined;
  drifted: EngineStatus | undefined;
  calls: string[];
}> {
  const { root, passingRunner, calls } = freshAgenticPin(id);
  const cfg = config({ engines: [agenticEngine(id, "1.0.0")] });
  const first = registry(cfg, root, {
    agenticProbeRunner: passingRunner,
    observeAgentVersion: fixedObservedVersion("1.0.0"),
  });
  const firstStatus = (await first.list()).engines.find((e) => e.id === id);
  const drifted = registry(cfg, root, {
    ...(driftRunner === undefined ? {} : { agenticProbeRunner: driftRunner }),
    observeAgentVersion: fixedObservedVersion("1.0.1"),
  });
  const driftedStatus = (await drifted.list()).engines.find((e) => e.id === id);
  return { first: firstStatus, drifted: driftedStatus, calls };
}

describe("agentic engines: the observed-version gate (a self-updating binary drifting from its proof)", () => {
  test("a proved version, then a simulated drift with no probe runner, flips the engine unavailable and the fix names both versions", async () => {
    const id = "agentic-verify-drift-noRunner";
    // With no probe runner to re-prove it, engined must refuse to serve
    // rather than trust a floor that was never actually checked for this binary.
    const { first, drifted } = await proveThenDrift(id, undefined);
    expect(first?.state).toBe("installed");
    expect(drifted?.state).toBe("unavailable");
    expect(drifted?.fix).toContain("1.0.0");
    expect(drifted?.fix).toContain("1.0.1");
    clearVerifiedVersion(id);
  });

  test("a proved version, then a simulated drift with a probe runner that fails, stays unavailable and names both versions and the failed probe", async () => {
    const id = "agentic-verify-drift-failRunner";
    const { runner: failingRunner } = trackingRunner({ ok: false, failedProbe: "byte-identical" });
    const { drifted } = await proveThenDrift(id, failingRunner);
    expect(drifted?.state).toBe("unavailable");
    expect(drifted?.fix).toContain("1.0.0");
    expect(drifted?.fix).toContain("1.0.1");
    expect(drifted?.fix).toContain("byte-identical");
    clearVerifiedVersion(id);
  });

  test("a proved version, then a simulated drift with a probe runner that passes, re-proves and persists the NEW observed version, not the configured pin", async () => {
    const id = "agentic-verify-drift-reproves";
    const { runner: passingRunner, calls: reproveCalls } = trackingRunner({ ok: true });
    const { drifted, calls } = await proveThenDrift(id, passingRunner);
    expect(drifted?.state).toBe("installed");
    expect(calls).toEqual(["1.0.0"]);
    expect(reproveCalls).toEqual(["1.0.1"]);
    const recorded = readFileSync(join(stateDir(), "agentic", id, "verified_version"), "utf8");
    expect(recorded.trim()).toBe("1.0.1");
    clearVerifiedVersion(id);
  });

  test("a binary that cannot be resolved at all is unavailable, names the reason, and never calls the probe runner", async () => {
    const id = "agentic-verify-unresolved-binary";
    const { root, passingRunner, calls } = freshAgenticPin(id);
    const reg = registry(config({ engines: [agenticEngine(id, "1.0.0")] }), root, {
      agenticProbeRunner: passingRunner,
      observeAgentVersion: () =>
        Promise.resolve({ ok: false, error: 'cursor\'s "agent" binary was not found on PATH' }),
    });
    const status = (await reg.list()).engines.find((e) => e.id === id);
    expect(status?.state).toBe("unavailable");
    expect(status?.fix).toContain("not found on PATH");
    expect(calls).toHaveLength(0);
    clearVerifiedVersion(id);
  });
});

/** A registry over one just-cleared agentic pin, wired to a tracking probe runner with the given outcome. */
function setupAgenticVerify(
  id: string,
  version: string,
  outcome: { ok: boolean; failedProbe?: string },
): { reg: EngineRegistry; calls: string[] } {
  clearVerifiedVersion(id);
  const root = newEnginesRoot();
  writeEngineSpec(root, id, AGENTIC);
  const { runner, calls } = trackingRunner(outcome);
  const reg = registry(config({ engines: [agenticEngine(id, version)] }), root, {
    agenticProbeRunner: runner,
  });
  return { reg, calls };
}

describe("agentic engines: a failed probe is cached, not retried, until the pin changes", () => {
  test("a failing pin is probed once; a later list on the same pin skips the runner", async () => {
    const id = "agentic-verify-fail-cached";
    const { reg, calls } = setupAgenticVerify(id, "1.0.0", {
      ok: false,
      failedProbe: "byte-identical",
    });

    const first = (await reg.list()).engines.find((e) => e.id === id);
    expect(first?.state).toBe("unavailable");
    expect(calls).toHaveLength(1);

    const second = (await reg.list()).engines.find((e) => e.id === id);
    expect(second?.state).toBe("unavailable");
    expect(calls).toHaveLength(1);

    clearVerifiedVersion(id);
  });

  test("bumping the pin after a failure re-arms the probe", async () => {
    const id = "agentic-verify-fail-rearm";
    const { reg, calls } = setupAgenticVerify(id, "1.0.0", {
      ok: false,
      failedProbe: "byte-identical",
    });

    await reg.list();
    expect(calls).toHaveLength(1);

    reg.reload(config({ engines: [agenticEngine(id, "1.0.1")] }));
    await reg.list();
    expect(calls).toHaveLength(2);

    clearVerifiedVersion(id);
  });

  test("two concurrent polls on the same unproved pin share one in-flight probe", async () => {
    const id = "agentic-verify-concurrent";
    const { reg, calls } = setupAgenticVerify(id, "1.0.0", { ok: true });

    const [a, b] = await Promise.all([reg.list(), reg.list()]);
    expect(a.engines.find((e) => e.id === id)?.state).toBe("installed");
    expect(b.engines.find((e) => e.id === id)?.state).toBe("installed");
    expect(calls).toHaveLength(1);

    clearVerifiedVersion(id);
  });
});

/** The version the door has actually proved for an agentic engine, as recorded on disk. */
function provedVersion(id: string): string {
  return readFileSync(join(stateDir(), "agentic", id, "verified_version"), "utf8").trim();
}

/** A registry over one just-cleared agentic pin whose version observation is the caller's own. */
function setupAgenticObserve(
  id: string,
  observeAgentVersion: () => Promise<ObservedVersion>,
): EngineRegistry {
  clearVerifiedVersion(id);
  const root = newEnginesRoot();
  writeEngineSpec(root, id, AGENTIC);
  return registry(config({ engines: [agenticEngine(id, "1.0.0")] }), root, {
    agenticProbeRunner: trackingRunner({ ok: true }).runner,
    observeAgentVersion,
  });
}

describe("a listing never blocks on the version observation; a launch always does", () => {
  test("the listing answers from the last observation and refreshes behind itself; start() re-observes", async () => {
    const id = "agentic-observe-off-listing";
    const observations: string[] = [];
    let observed = "1.0.0";
    const reg = setupAgenticObserve(id, () => {
      observations.push(observed);
      return Promise.resolve({ ok: true, version: observed });
    });

    // The first listing has nothing to answer from and pays the observation.
    await reg.list();
    expect(observations).toEqual(["1.0.0"]);
    expect(provedVersion(id)).toBe("1.0.0");

    // A self-update the door has not observed yet: the listing answers from
    // the version it knows rather than waiting, so the proof on file is still
    // the old one even though the refresh it kicked has seen the new one.
    observed = "1.0.1";
    await reg.list();
    expect(provedVersion(id)).toBe("1.0.0");

    // A launch is the proof point and re-observes, so what it proves is what
    // the binary reports at that moment -- never what a poll cached earlier.
    observed = "1.0.2";
    await reg.start(id);
    expect(provedVersion(id)).toBe("1.0.2");

    clearVerifiedVersion(id);
  });

  test("a stalled observation blocks neither a listing nor a second poll, and only one is in flight", async () => {
    const id = "agentic-observe-stalled";
    let spawns = 0;
    let release: (() => void) | undefined;
    const reg = setupAgenticObserve(id, () => {
      spawns += 1;
      return spawns === 1
        ? Promise.resolve({ ok: true, version: "1.0.0" })
        : new Promise((resolve) => {
            release = () => resolve({ ok: true, version: "1.0.0" });
          });
    });

    await reg.list();
    expect(spawns).toBe(1);

    // Both polls answer while the refresh the first one kicked is still stuck.
    const stalled = (await reg.list()).engines.find((e) => e.id === id);
    expect(stalled?.state).toBe("installed");
    expect((await reg.list()).engines.find((e) => e.id === id)?.state).toBe("installed");
    expect(spawns).toBe(2);

    release?.();
    clearVerifiedVersion(id);
  });
});

describe("serves()", () => {
  test("returns the loaded spec's serves list for a container engine", () => {
    const { reg } = setupLlama();
    expect(reg.serves("llama")).toEqual(["/openai/v1/chat/completions"]);
  });

  test("falls back to the kind-serves table for a spec-less proxy engine", () => {
    const reg = registry(config({ engines: [specLessProxyEngine("scribe")] }), newEnginesRoot());
    expect(reg.serves("scribe")).toEqual(["/openai/v1/audio/transcriptions"]);
  });

  test("unknown id serves nothing rather than throwing", () => {
    const reg = registry(config({ engines: [] }), newEnginesRoot());
    expect(reg.serves("nope")).toEqual([]);
  });
});

describe("the kind-dependent filename/role split runs at registry construction, not parse", () => {
  test("a whisper-shaped route (filename, no role) parses and is accepted", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "whisper-like", STT_REAL_COMMAND);
    const reg = registry(
      config({
        engines: [engine({ id: "whisper-like", models_dir: "/data/whisper" })],
        routes: [
          route({ engine: "whisper-like", upstream: "local", model: "x", filename: "x.bin" }),
        ],
      }),
      root,
    );
    expect(reg.serves("whisper-like")).toEqual(["/openai/v1/audio/transcriptions"]);
  });

  test("a llama-shaped route without role still fails, at construction", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "llama-like", PULLED_CONTAINER);
    expect(
      () =>
        new EngineRegistry(
          config({
            engines: [engine({ id: "llama-like", models_dir: "/data/gguf" })],
            routes: [
              route({ engine: "llama-like", upstream: "local", model: "x", filename: "x.gguf" }),
            ],
          }),
          { enginesRoot: root, bunx: BUNX },
        ),
    ).toThrow(RX_MISSING_ROLE);
  });

  test("@/llama/sonnet-5 stays invalid: a filename-less llama route fails at construction", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "llama-like", PULLED_CONTAINER);
    expect(
      () =>
        new EngineRegistry(
          config({
            engines: [engine({ id: "llama-like", models_dir: "/data/gguf" })],
            routes: [route({ engine: "llama-like", upstream: "local", model: "sonnet-5" })],
          }),
          { enginesRoot: root, bunx: BUNX },
        ),
    ).toThrow(RX_MISSING_FILENAME);
  });
});

/** ComfyUI's own listen port, which its image is the one to `EXPOSE`. */
const COMFY_CONTAINER_PORT = 8188;

describe("comfy: shipped spec", () => {
  test("the run argv takes GPU_FLAGS, label=disable and latent2rgb, and publishes to no wildcard interface", () => {
    const loaded = loadSpec(engine({ id: "comfy" }), {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
    });
    const { spec } = loaded;
    if (!isContainerSpec(spec)) {
      throw new Error("engines/comfy/spec.toml must be a container spec");
    }
    const argv = buildRunArgs("engined-comfy", spec, COMFY_CONTAINER_PORT);
    expect(argv).toContain("--preview-method");
    expect(argv).toContain("latent2rgb");
    expect(argv).toContain("/dev/kfd");
    expect(argv).toContain("/dev/dri");
    expect(argv).toContain("label=disable");
    expect(argv).not.toContain("-P");
    expect(argv.some((a) => a.startsWith("0.0.0.0::"))).toBe(false);
  });
});

/** The docker calls the registry makes to get `comfy` into `state: "running"`; each `docker port` lookup answers a different host port, none of which any assertion reads. */
function comfyExec(): Exec {
  return buildExec({ portSeed: 40_000, containerPort: COMFY_CONTAINER_PORT });
}

const READY_PROBE: Probe = () => Promise.resolve({ status: 200 });

const EMPTY_QUEUE: QueueSnapshot = { queue_running: [], queue_pending: [] };
const BUSY_QUEUE: QueueSnapshot = { queue_running: [{ id: "job-1" }], queue_pending: [] };

function comfyConfig(): Config {
  return config({
    engines: [engine({ id: "comfy", idle_stop_seconds: 0.05, ready_timeout_s: 5 })],
  });
}

/** Builds a comfy-backed registry from the given fixtures, runs `body` against it, and always shuts it down. */
async function withComfyRegistry(
  opts: {
    exec: Exec;
    cfg: Config;
    queueFetch: () => Promise<QueueSnapshot>;
    comfyPollIntervalMs: number;
  },
  body: (reg: EngineRegistry, lifecycle: DockerLifecycle) => Promise<void>,
): Promise<void> {
  const lifecycle = new DockerLifecycle(opts.exec, READY_PROBE);
  const reg = new EngineRegistry(opts.cfg, {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    lifecycle,
    queueFetch: opts.queueFetch,
    comfyPollIntervalMs: opts.comfyPollIntervalMs,
  });
  try {
    await body(reg, lifecycle);
  } finally {
    await reg.shutdown();
  }
}

describe("comfy: idle timer driven by /queue polling", () => {
  test("an empty queue advances the idle timer to a real stop", async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfig(),
        queueFetch: () => Promise.resolve(EMPTY_QUEUE),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        const started = await reg.start("comfy");
        expect(started.state).toBe("running");
        expect(lifecycle.getStatus("comfy").private_url).not.toBeNull();

        await Bun.sleep(300);

        const after = reg.get("comfy");
        expect(after?.state).toBe("installed");
        expect(lifecycle.getStatus("comfy").private_url).toBeNull();
      },
    );
  });

  test("a non-empty queue never lets the idle timer fire", async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfig(),
        queueFetch: () => Promise.resolve(BUSY_QUEUE),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        const started = await reg.start("comfy");
        expect(started.state).toBe("running");

        await Bun.sleep(300);

        const after = reg.get("comfy");
        expect(after?.state).toBe("running");
        expect(lifecycle.getStatus("comfy").private_url).not.toBeNull();
      },
    );
  });
});

describe("comfy: the lease a busy queue takes", () => {
  test("a queue that turns busy takes the lease in the same tick it is observed, with no awaited docker work in between", async () => {
    const execLog: string[][] = [];
    const base = comfyExec();
    const exec: Exec = (args) => {
      execLog.push([...args]);
      return base(args);
    };
    let busy = false;
    await withComfyRegistry(
      {
        exec,
        cfg: config({
          engines: [engine({ id: "comfy", idle_stop_seconds: 30, ready_timeout_s: 5 })],
        }),
        queueFetch: () => Promise.resolve(busy ? BUSY_QUEUE : EMPTY_QUEUE),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        await reg.start("comfy");
        await Bun.sleep(60);
        const settled = execLog.length;

        busy = true;
        await Bun.sleep(90);

        // Every docker call the transition awaits is a window in which the
        // container holds no lease and no countdown: a model switch landing
        // there stops a comfy that has just been observed working.
        expect(execLog.slice(settled)).toEqual([]);
        expect(lifecycle.getStatus("comfy").active_leases).toBe(1);
        expect(lifecycle.getStatus("comfy").state).toBe("running");
      },
    );
  });
});

describe("comfy: resolved URL outlives its container by exactly nothing", () => {
  test("two successive starts yield two different private_url values", async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfig(),
        queueFetch: () => Promise.resolve(EMPTY_QUEUE),
        comfyPollIntervalMs: 60_000,
      },
      async (reg, lifecycle) => {
        await reg.start("comfy");
        const first = lifecycle.getStatus("comfy").private_url;
        await lifecycle.removeEngine("comfy");
        await reg.start("comfy");
        const second = lifecycle.getStatus("comfy").private_url;

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
      },
    );
  });
});

/** A lifecycle whose every `docker run` argv lands in `runArgvCalls`; the host port it hands back is never read. */
function capturingLifecycle(runArgvCalls: string[][], containerPort = 8080): DockerLifecycle {
  return new DockerLifecycle(
    buildExec({ portSeed: 50_000, containerPort, runLog: runArgvCalls }),
    READY_PROBE,
  );
}

/** A registry over one engine, its lifecycle wired to `capturingLifecycle` so `runArgvCalls` fills in as `start()` runs it. */
function capturingRegistry(
  entry: EngineEntry,
  containerPort: number,
): { reg: EngineRegistry; runArgvCalls: string[][] } {
  const runArgvCalls: string[][] = [];
  const reg = new EngineRegistry(config({ engines: [entry] }), {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    lifecycle: capturingLifecycle(runArgvCalls, containerPort),
  });
  return { reg, runArgvCalls };
}

describe("spec construction is routed through the per-engine builder", () => {
  test("comfy started through the registry carries its models bind mount in the run argv", async () => {
    const { reg, runArgvCalls } = capturingRegistry(
      engine({ id: "comfy", models_dir: "/data/comfy-models", ready_timeout_s: 5 }),
      COMFY_CONTAINER_PORT,
    );
    try {
      await reg.start("comfy");
      expect(runArgvCalls).toHaveLength(1);
      const [argv] = runArgvCalls;
      expect(argv).toContain("-v");
      expect(argv?.some((a) => a === "/data/comfy-models:/opt/comfyui/models")).toBe(true);
    } finally {
      await reg.shutdown();
    }
  });

  test("llama started through the registry carries --models-preset and its :ro mounts", async () => {
    // start() on an openai-http engine with a models_dir renders the preset
    // to stateDir()/llama/preset.ini unconditionally (paths.ts's own
    // llamaPresetPath, not overridable via RegistryOptions) -- the
    // same path the real running engine has bind-mounted.
    const restoreStateHome = redirectStateHome();
    const { reg, runArgvCalls } = capturingRegistry(
      engine({
        id: "llama",
        models_dir: "/data/gguf",
        models_max: 3,
        ready_timeout_s: 5,
      }),
      8080,
    );
    try {
      await reg.start("llama");
      expect(runArgvCalls).toHaveLength(1);
      const [argv] = runArgvCalls;
      expect(argv).toContain("--models-preset");
      expect(argv?.some((a) => a === "/data/gguf:/models:ro")).toBe(true);
      expect(argv?.some((a) => a.includes("llama/preset.ini:/preset.ini:ro"))).toBe(true);
    } finally {
      await reg.shutdown();
      restoreStateHome();
    }
  });
});

// Every `toHaveLength(1)` above reads as "exactly one container started".
// That only holds while the log sees one-shot runs too: an artifact check is
// a `docker run` no fixture above triggers, and a log blind to it would let
// an extra container start pass a length assertion unnoticed.
test("an artifact only a named volume can hold starts its own check container, logged beside the detached start", async () => {
  const root = newEnginesRoot();
  writeEngineSpec(root, "volume-stt", STT_VOLUME_ARTIFACT);
  const runArgvCalls: string[][] = [];
  const reg = new EngineRegistry(
    config({ engines: [engine({ id: "volume-stt", ready_timeout_s: 5 })] }),
    { enginesRoot: root, bunx: BUNX, lifecycle: capturingLifecycle(runArgvCalls) },
  );
  try {
    await reg.start("volume-stt");
    expect(runArgvCalls).toHaveLength(2);
    const [check, started] = runArgvCalls;
    expect(check).toContain("--rm");
    expect(check?.some((a) => a.includes("test -e '/models/fake.bin'"))).toBe(true);
    expect(started?.[1]).toBe("-d");
  } finally {
    await reg.shutdown();
  }
});

const RX_KOKORO_LIKE = /kokoro-like/;

// [engine.args] reached argv only via buildLlamaSpec and buildComfySpec --
// every other container kind (tts, stt, any future one) fell through
// loadEngineSpec's `return loaded;` untouched, so args were parsed,
// forbidden-flag-checked at config parse, and then silently dropped.
describe("a container kind with no dedicated builder still gets [engine.args]", () => {
  test("a stt engine's real command carries [engine.args] appended in the run argv", async () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "whisper-like", STT_REAL_COMMAND);
    const runArgvCalls: string[][] = [];
    const reg = new EngineRegistry(
      config({
        engines: [engine({ id: "whisper-like", args: { threads: 4 }, ready_timeout_s: 5 })],
      }),
      {
        enginesRoot: root,
        bunx: BUNX,
        lifecycle: capturingLifecycle(runArgvCalls),
      },
    );
    try {
      await reg.start("whisper-like");
      expect(runArgvCalls).toHaveLength(1);
      const [argv] = runArgvCalls;
      const threadsIdx = argv?.indexOf("--threads");
      expect(threadsIdx).toBeGreaterThan(-1);
      expect(argv?.[(threadsIdx as number) + 1]).toBe("4");
      // The spec's own command survives untouched, ahead of the appended args.
      expect(argv).toContain("--host");
    } finally {
      await reg.shutdown();
    }
  });

  /**
   * chatterbox/kokoro's real shape: `command = []` because the image's own
   * CMD is already correct. Appending flags to an EMPTY command array does
   * not extend anything -- `buildRunArgs` pushes `image, ...command`, so an
   * empty command means "run the image's own CMD unmodified" and a
   * non-empty one REPLACES it. Honouring args there would silently corrupt
   * the container's launch, not merely do nothing; rejecting at spec-load
   * is the only shape that gives an operator either the effect or an error.
   */
  test("a tts engine with an image-defined (empty) command rejects non-empty [engine.args] loudly, at construction", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "kokoro-like", TTS_EMPTY_COMMAND);
    expect(
      () =>
        new EngineRegistry(
          config({
            engines: [engine({ id: "kokoro-like", args: { foo: "bar" } })],
          }),
          { enginesRoot: root, bunx: BUNX },
        ),
    ).toThrow(RX_KOKORO_LIKE);
  });

  test("a tts engine with an image-defined (empty) command and NO [engine.args] starts clean", async () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "kokoro-like", TTS_EMPTY_COMMAND);
    const runArgvCalls: string[][] = [];
    const reg = new EngineRegistry(
      config({ engines: [engine({ id: "kokoro-like", ready_timeout_s: 5 })] }),
      {
        enginesRoot: root,
        bunx: BUNX,
        lifecycle: capturingLifecycle(runArgvCalls),
      },
    );
    try {
      await reg.start("kokoro-like");
      expect(runArgvCalls).toHaveLength(1);
    } finally {
      await reg.shutdown();
    }
  });
});

/**
 * Liveness the test can change mid-run: the container under test is up when
 * it starts and dies afterwards, so a fixed answer cannot express it -- a
 * dead-from-the-first-inspect container never reaches `running` at all.
 */
function comfyExecLiveness(live: { alive: boolean }): Exec {
  const base = comfyExec();
  return (args) => {
    if (args[0] === "inspect") {
      return Promise.resolve(containerRunning(live.alive));
    }
    return base(args);
  };
}

function comfyLongIdleConfig(): Config {
  return config({
    engines: [engine({ id: "comfy", idle_stop_seconds: 60, ready_timeout_s: 5 })],
  });
}

describe("comfy: a container that dies underneath engined", () => {
  test("a refused /queue poll against a gone container clears the stale running state", async () => {
    const comfyLive = { alive: true };
    await withComfyRegistry(
      {
        exec: comfyExecLiveness(comfyLive),
        cfg: comfyLongIdleConfig(),
        queueFetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        const started = await reg.start("comfy");
        expect(started.state).toBe("running");
        expect(lifecycle.getStatus("comfy").private_url).not.toBeNull();

        comfyLive.alive = false;
        await Bun.sleep(300);

        // Never a 200 naming a dead address: the door reports what docker says.
        const after = reg.get("comfy");
        expect(after?.state).toBe("installed");
        expect(lifecycle.getStatus("comfy").private_url).toBeNull();
      },
    );
  });

  test("a refused poll against a container still up leaves it running", async () => {
    await withComfyRegistry(
      {
        exec: comfyExecLiveness({ alive: true }),
        cfg: comfyLongIdleConfig(),
        queueFetch: () => Promise.reject(new Error("socket hang up")),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        expect((await reg.start("comfy")).state).toBe("running");

        await Bun.sleep(300);

        const after = reg.get("comfy");
        expect(after?.state).toBe("running");
        expect(lifecycle.getStatus("comfy").private_url).not.toBeNull();
      },
    );
  });
});

/** Mirrors engines/whisper's real shape: a real "-m <path>" pair for `withModelFile` to rewrite. */
const STT_WITH_MODEL_FLAG = `
kind = "stt"
upstream = "self"
image = "engined/fakestt:local"
obtain = "build"
serves = ["/openai/v1/audio/transcriptions"]
command = ["--host", "0.0.0.0", "-m", "/models/default.bin"]

[ready]
path = "/health"
status = 200
`;

/** A registry over one stt-kind engine with two model-bearing routes, its lifecycle wired to a stop-and-restart-tracking exec fake and handed back so a test can drive leases directly. */
function sttSwitchRegistry(wrap: (base: Exec) => Exec = (base) => base): {
  reg: EngineRegistry;
  lifecycle: DockerLifecycle;
  runLog: string[][];
  stopLog: string[][];
} {
  const root = newEnginesRoot();
  writeEngineSpec(root, "whisper-like", STT_WITH_MODEL_FLAG);
  const runLog: string[][] = [];
  const stopLog: string[][] = [];
  const lifecycle = new DockerLifecycle(
    wrap(buildExec({ runLog, stopLog, portSeed: 51_000 })),
    READY_PROBE,
  );
  const reg = new EngineRegistry(
    config({
      engines: [engine({ id: "whisper-like", models_dir: "/data/whisper" })],
      routes: [
        route({
          engine: "whisper-like",
          upstream: "local",
          model: "small",
          filename: "small.bin",
        }),
        route({ engine: "whisper-like", upstream: "local", model: "big", filename: "big.bin" }),
      ],
    }),
    { enginesRoot: root, bunx: BUNX, lifecycle },
  );
  return { reg, lifecycle, runLog, stopLog };
}

describe("model-bearing stt: switching models is a stop-and-restart", () => {
  test("starting with a model bakes that route's filename into the -m argument", async () => {
    const { reg, runLog } = sttSwitchRegistry();
    try {
      await reg.start("whisper-like", "small");
      expect(runLog).toHaveLength(1);
      const argv = runLog[0] as string[];
      const idx = argv.indexOf("-m");
      expect(argv[idx + 1]).toBe("/models/small.bin");
    } finally {
      await reg.shutdown();
    }
  });

  test("switching models with no active leases stops the container and restarts it with the new one", async () => {
    const { reg, runLog, stopLog } = sttSwitchRegistry();
    try {
      await reg.start("whisper-like", "small");
      expect(runLog).toHaveLength(1);
      expect(stopLog).toHaveLength(0);

      await reg.start("whisper-like", "big");
      expect(stopLog).toHaveLength(1);
      expect(runLog).toHaveLength(2);
      const secondArgv = runLog[1] as string[];
      expect(secondArgv[secondArgv.indexOf("-m") + 1]).toBe("/models/big.bin");
    } finally {
      await reg.shutdown();
    }
  });

  test("requesting the same resident model again neither stops nor restarts", async () => {
    const { reg, runLog, stopLog } = sttSwitchRegistry();
    try {
      await reg.start("whisper-like", "small");
      await reg.start("whisper-like", "small");
      expect(runLog).toHaveLength(1);
      expect(stopLog).toHaveLength(0);
    } finally {
      await reg.shutdown();
    }
  });

  test("a switch while a request is in flight is refused with EngineBusyError and never restarts", async () => {
    const { reg, lifecycle, runLog, stopLog } = sttSwitchRegistry();
    try {
      const started = await reg.start("whisper-like", "small");
      expect(started.state).toBe("running");
      expect(lifecycle.getStatus("whisper-like").private_url).not.toBeNull();
      lifecycle.beginLease("whisper-like");

      await expect(reg.start("whisper-like", "big")).rejects.toThrow(EngineBusyError);
      expect(runLog).toHaveLength(1);
      expect(stopLog).toHaveLength(0);
    } finally {
      await reg.shutdown();
    }
  });
});

/**
 * Holds the first `docker inspect` that follows the container's own `run`:
 * the status probe `start` ends with, which is the window a caller's lease
 * has not been taken in yet.
 */
function holdingProbe(reached: () => void, held: Promise<void>): (base: Exec) => Exec {
  let ran = false;
  let holding = false;
  return (base) => async (args) => {
    if (args[0] === "run") {
      ran = true;
    }
    if (ran && !holding && args[0] === "inspect") {
      holding = true;
      reached();
      await held;
    }
    return base(args);
  };
}

test("a model switch cannot stop a container out from under a start still in flight", async () => {
  const atProbe = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { reg, runLog, stopLog } = sttSwitchRegistry(
    holdingProbe(atProbe.resolve, release.promise),
  );
  try {
    const first = reg.start("whisper-like", "small");
    await atProbe.promise;

    // The first start has its container up and is inside its closing probe;
    // its caller takes a lease only once that returns.
    await expect(reg.start("whisper-like", "big")).rejects.toThrow(EngineBusyError);
    release.resolve();
    await first;

    expect(runLog).toHaveLength(1);
    expect(stopLog).toHaveLength(0);
  } finally {
    release.resolve();
    await reg.shutdown();
  }
});

test("a model switch one microtask after a leased start resolves finds the lease already held", async () => {
  const { reg, runLog, stopLog } = sttSwitchRegistry();
  try {
    // `startsInFlight` no longer covers the engine here -- `start` has
    // returned -- so the only thing standing between the container and a
    // competing switch is a lease the start itself took.
    const started = await reg.start("whisper-like", "small", { lease: true });
    expect(started.active_leases).toBe(1);

    await expect(reg.start("whisper-like", "big")).rejects.toThrow(EngineBusyError);
    expect(runLog).toHaveLength(1);
    expect(stopLog).toHaveLength(0);
  } finally {
    await reg.shutdown();
  }
});
