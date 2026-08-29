import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { buildRunArgs, DockerLifecycle, type Probe } from "./docker.ts";
import {
  type AgenticProbeRunner,
  EngineRegistry,
  type QueueSnapshot,
  type RegistryOptions,
} from "./engines.ts";
import type { Exec, ExecResult } from "./exec.ts";
import type { SecretOutcome } from "./secrets.ts";
import { loadSpec } from "./spec.ts";
import {
  BUNX,
  clearVerifiedVersion,
  config,
  ENGINES_ROOT,
  engine,
  inspectSinglePort,
  makeTestRoot,
  model,
  portResult,
  writeEngineSpec,
} from "./test-support.ts";
import { type Config, type EngineEntry, type EngineStatus, isContainerSpec } from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-engines-test-");

/**
 * Redirects `stateDir()` under `TEST_ROOT` for whatever the caller does next,
 * returning a restore function for its `finally`. Needed wherever the code
 * under test resolves a path via `stateDir()` (paths.ts) directly rather than
 * through an injectable option -- `local-llama`'s preset path is one such
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
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/v1/chat/completions"]
command = ["--model", "x"]

[ready]
path = "/health"
status = 200
`;

const BUILT_CONTAINER = `
kind = "tts"
image = "engined/kokoro:local"
obtain = "build"
serves = ["/v1/audio/speech"]
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
serves = ["/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code@{claude_version}", "-p"]
`;

/** No `{claude_version}` placeholder: loads even when the engine configures none, unlike the shipped spec. */
const AGENTIC_NO_VERSION_PLACEHOLDER = `
kind = "agentic-cli"
serves = ["/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code", "-p"]
`;

const COMFY_CONTAINER = `
kind = "comfy"
image = "engined/comfy:local"
obtain = "build"
serves = []
command = ["--serve"]

[ready]
path = "/queue"
status = 200
`;

/** Mirrors engines/chatterbox and engines/kokoro's real shape: the image's own CMD is already correct, so command is deliberately empty. */
const TTS_EMPTY_COMMAND = `
kind = "tts"
image = "engined/faketts:local"
obtain = "build"
serves = ["/v1/audio/speech"]
command = []

[ready]
path = "/health"
status = 200
`;

/** Mirrors engines/whisper's real shape: a real command that flags can extend. */
const STT_REAL_COMMAND = `
kind = "stt"
image = "engined/fakestt:local"
obtain = "build"
serves = ["/v1/audio/transcriptions"]
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
    expect(listed?.serves).toEqual(["/v1/chat/completions"]);
    expect(listed?.fix).toBe('remove "llama" from "disabled" in config.toml');
    // list() probes docker for every engine it does not short-circuit.
    expect(execLog).toEqual([]);

    expect(reg.get("llama")?.disabled).toBe(true);
    await expect(reg.start("llama")).rejects.toThrow(RX_DISABLED_START);
    expect(execLog).toEqual([]);
  });

  test("are not advertised by models(), which is what a caller may put in `model`", () => {
    // A model-less kind: its engine id IS its model string, so excluding it
    // is the only way the disabling reaches /v1/models at all.
    const voice = engine({
      id: "voice",
      egress: "remote",
      kind: "tts",
      base_url: "https://example.com/voice",
      secret: { service: "voice", username: "u", header: "x-api-key" },
    });
    const enabled = registry(config({ engines: [voice] }), newEnginesRoot());
    expect(enabled.models()).toContain("voice");

    const off = registry(config({ engines: [{ ...voice, disabled: true }] }), newEnginesRoot());
    expect(off.models()).not.toContain("voice");
  });

  test("a reload that disables an engine tears its container down like a removal", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "llama", PULLED_CONTAINER);
    // The entry survives a disabling reload, so the removal that a dropped
    // engine gets for free has to be asked for -- this is that ask.
    class RemovalSpy extends DockerLifecycle {
      readonly removed: string[] = [];
      override removeEngine(id: string): Promise<void> {
        this.removed.push(id);
        return super.removeEngine(id);
      }
    }
    const lifecycle = new RemovalSpy(OK_EXEC);
    const reg = registry(config({ engines: [engine({ id: "llama" })] }), root, { lifecycle });

    reg.reload(config({ engines: [engine({ id: "llama", disabled: true })] }));
    expect(lifecycle.removed).toEqual(["llama"]);
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
    // local-llama's real shape: obtain = "build", no Dockerfile shipped here
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

describe("installed engines", () => {
  test("an engine merely stopped is installed with a null private_url, never reported as broken", async () => {
    const { reg } = setupLlama();
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.state).toBe("installed");
    expect(listed?.private_url).toBeNull();
    expect(listed?.fix).toBeUndefined();
  });

  test("private_url is null before any start, from both get() and list()", async () => {
    const lifecycle = new DockerLifecycle(OK_EXEC);
    const { reg } = setupLlama({ lifecycle });
    expect(reg.get("llama")?.private_url).toBeNull();
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.private_url).toBeNull();
  });
});

/** A remote address that is merely a proxy: it launches nothing, so it carries no `claude_version` and is never routed through the agentic gate. */
const REMOTE_ENGINE = engine({
  id: "remote-proxy",
  egress: "remote",
  kind: "openai-http",
  base_url: "https://api.kimi.com/coding/",
  secret: { service: "moonshot-api", username: "kimi-k2.7-code", header: "x-api-key" },
});

/** A second, ordinary engine in the same config, so "does the rest of the inventory still work" is provable in the same response. */
function withAnotherEngine(root: string): Config {
  writeEngineSpec(root, "other", PULLED_CONTAINER);
  return config({ engines: [REMOTE_ENGINE, engine({ id: "other" })] });
}

/** Lists the remote-proxy engine (plus its ordinary sibling) under a given keyring outcome. */
async function listRemoteProxy(
  secretResolves: () => Promise<SecretOutcome>,
): Promise<{ proxy: EngineStatus | undefined; other: EngineStatus | undefined }> {
  const root = newEnginesRoot();
  const reg = registry(withAnotherEngine(root), root, { secretResolves });
  const listed = await reg.list();
  return {
    proxy: listed.engines.find((e) => e.id === "remote-proxy"),
    other: listed.engines.find((e) => e.id === "other"),
  };
}

describe("remote-address engines: get() stays optimistic", () => {
  test("get() does not itself resolve the keyring", () => {
    const reg = registry(config({ engines: [REMOTE_ENGINE] }), newEnginesRoot(), {
      secretResolves: () => Promise.resolve({ ok: false, reason: "missing", fix: "unused" }),
    });
    // No image/keyring round trip happens synchronously; get() reports the
    // same resting "installed" a never-probed container would.
    expect(reg.get("remote-proxy")?.state).toBe("installed");
    expect(reg.get("remote-proxy")?.private_url).toBeNull();
  });
});

describe("remote-address engines: GET /v1/engines resolves the keyring per request", () => {
  test("GET /v1/engines: installed when the secret resolves", async () => {
    const { proxy: status } = await listRemoteProxy(() =>
      Promise.resolve({ ok: true, value: "kimi-secret" } as SecretOutcome),
    );
    expect(status?.state).toBe("installed");
    expect(status?.private_url).toBeNull();
  });

  test("GET /v1/engines: a missing outcome is unavailable, fix names secret-tool store", async () => {
    const { proxy: kimi, other } = await listRemoteProxy(() =>
      Promise.resolve({
        ok: false,
        reason: "missing",
        fix: "secret-tool store --label='moonshot-api' service moonshot-api username kimi-k2.7-code",
      } satisfies SecretOutcome),
    );
    expect(kimi?.state).toBe("unavailable");
    expect(kimi?.fix).toContain("secret-tool store");
    expect(other?.state).toBe("installed");
  });

  test("GET /v1/engines: a locked outcome is unavailable but offers no store command", async () => {
    const { proxy: kimi, other } = await listRemoteProxy(() =>
      Promise.resolve({
        ok: false,
        reason: "locked",
        fix: "keyring is locked; resolves automatically once the operator signs in",
      } satisfies SecretOutcome),
    );
    expect(kimi?.state).toBe("unavailable");
    expect(kimi?.fix).not.toContain("secret-tool store");
    expect(kimi?.fix).toContain("locked");

    expect(other?.state).toBe("installed");
  });
});

function remoteAgenticEngine(id: string, claudeVersion?: string): EngineEntry {
  return engine({
    id,
    egress: "remote",
    kind: "agentic-cli",
    base_url: `https://example.com/${id}`,
    secret: { service: id, username: "u", header: "x-api-key" },
    claude_version: claudeVersion,
  });
}

function trackingRunner(outcome: { ok: boolean; failedProbe?: string }): {
  runner: AgenticProbeRunner;
  calls: Array<{ engineId: string; version: string }>;
} {
  const calls: Array<{ engineId: string; version: string }> = [];
  const runner: AgenticProbeRunner = (eng, version) => {
    calls.push({ engineId: eng.id, version });
    return Promise.resolve(outcome);
  };
  return { runner, calls };
}

function secretResolvesOk(): Promise<SecretOutcome> {
  return Promise.resolve({ ok: true, value: "secret" } as SecretOutcome);
}

function secretResolvesMissing(): Promise<SecretOutcome> {
  return Promise.resolve({
    ok: false,
    reason: "missing",
    fix: "secret-tool store ...",
  } as SecretOutcome);
}

describe("remote-address agentic engines: unavailable paths never reach a real spawn", () => {
  test("an unproved pin is unavailable even once the secret resolves, and the probe runner is never called", async () => {
    const id = "remote-agentic-unproved";
    clearVerifiedVersion(id);
    const { runner, calls } = trackingRunner({ ok: true });
    const reg = registry(config({ engines: [remoteAgenticEngine(id)] }), newEnginesRoot(), {
      secretResolves: secretResolvesOk,
      agenticProbeRunner: runner,
    });
    const listed = (await reg.list()).engines.find((e) => e.id === id);
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toContain("claude_version");
    expect(calls).toHaveLength(0);
  });

  test("a secret that fails to resolve is unavailable before the agentic gate is ever consulted", async () => {
    const id = "remote-agentic-nosecret";
    clearVerifiedVersion(id);
    const { runner, calls } = trackingRunner({ ok: true });
    const reg = registry(
      config({ engines: [remoteAgenticEngine(id, "2.0.0")] }),
      newEnginesRoot(),
      { secretResolves: secretResolvesMissing, agenticProbeRunner: runner },
    );
    const listed = (await reg.list()).engines.find((e) => e.id === id);
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toContain("secret-tool store");
    expect(calls).toHaveLength(0);
  });

  test("a resolved secret and an unproved version pin is unavailable -- no real spawn occurs", async () => {
    const id = "remote-agentic-pin-unproved";
    clearVerifiedVersion(id);
    const { runner, calls } = trackingRunner({ ok: false, failedProbe: "byte-identical" });
    const reg = registry(
      config({ engines: [remoteAgenticEngine(id, "1.0.0")] }),
      newEnginesRoot(),
      { secretResolves: secretResolvesOk, agenticProbeRunner: runner },
    );
    const listed = (await reg.list()).engines.find((e) => e.id === id);
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toContain("byte-identical");
    expect(calls).toEqual([{ engineId: id, version: "1.0.0" }]);
    clearVerifiedVersion(id);
  });
});

describe("remote-address agentic engines: gated the same as a local one once proved", () => {
  test("the secret resolving and the probes passing together yield installed; a later list skips the runner", async () => {
    const id = "remote-agentic-proved";
    clearVerifiedVersion(id);
    const { runner, calls } = trackingRunner({ ok: true });
    const opts: Partial<RegistryOptions> = {
      secretResolves: secretResolvesOk,
      agenticProbeRunner: runner,
    };
    const cfg = config({ engines: [remoteAgenticEngine(id, "3.0.0")] });
    const first = (await registry(cfg, newEnginesRoot(), opts).list()).engines.find(
      (e) => e.id === id,
    );
    expect(first?.state).toBe("installed");
    expect(calls).toHaveLength(1);

    const second = (await registry(cfg, newEnginesRoot(), opts).list()).engines.find(
      (e) => e.id === id,
    );
    expect(second?.state).toBe("installed");
    expect(calls).toHaveLength(1);

    clearVerifiedVersion(id);
  });
});

describe("GET /v1/models", () => {
  test("includes chain names, GGUF ids and aliases, agentic and audio engine ids; excludes comfy", () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "claude", AGENTIC);
    writeEngineSpec(root, "kokoro", BUILT_CONTAINER);
    writeEngineSpec(root, "comfy", COMFY_CONTAINER);
    const cfg = config({
      engines: [
        engine({ id: "claude", egress: "remote", claude_version: "1.2.3" }),
        engine({ id: "kokoro" }),
        engine({ id: "comfy" }),
      ],
      models: [model({ id: "ornith", engine: "claude", aliases: ["bird"] })],
      chains: { "chain-private": ["@/local/ornith"] },
    });
    const reg = registry(cfg, root);
    const names = reg.models();
    expect(names).toContain("ornith");
    expect(names).toContain("bird");
    expect(names).toContain("claude");
    expect(names).toContain("kokoro");
    expect(names).toContain("chain-private");
    expect(names).not.toContain("comfy");
  });
});

function agenticEngine(id: string, version: string): EngineEntry {
  return engine({ id, egress: "remote", claude_version: version });
}

describe("agentic engines: unproved by default", () => {
  test("no claude_version configured is unavailable, naming the engine", async () => {
    const root = newEnginesRoot();
    writeEngineSpec(root, "agentic-verify-noversion", AGENTIC_NO_VERSION_PLACEHOLDER);
    const reg = registry(config({ engines: [engine({ id: "agentic-verify-noversion" })] }), root);
    const listed = (await reg.list()).engines.find((e) => e.id === "agentic-verify-noversion");
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toContain("claude_version");
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
    const calls: Array<{ engineId: string; version: string }> = [];
    const failingRunner: AgenticProbeRunner = (eng, version) => {
      calls.push({ engineId: eng.id, version });
      return Promise.resolve({ ok: false, failedProbe: "byte-identical" });
    };
    const reg = registry(config({ engines: [agenticEngine(id, "2.0.0")] }), root, {
      agenticProbeRunner: failingRunner,
    });

    const listed = (await reg.list()).engines.find((e) => e.id === id);

    expect(calls).toEqual([{ engineId: id, version: "2.0.0" }]);
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
    const calls: Array<{ engineId: string; version: string }> = [];
    const passingRunner: AgenticProbeRunner = (eng, version) => {
      calls.push({ engineId: eng.id, version });
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

/** A registry over one just-cleared agentic pin, wired to a tracking probe runner with the given outcome. */
function setupAgenticVerify(
  id: string,
  version: string,
  outcome: { ok: boolean; failedProbe?: string },
): { reg: EngineRegistry; calls: Array<{ engineId: string; version: string }> } {
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

describe("serves()", () => {
  test("returns the loaded spec's serves list for a container engine", () => {
    const { reg } = setupLlama();
    expect(reg.serves("llama")).toEqual(["/v1/chat/completions"]);
  });

  test("falls back to the kind-serves table for a remote-address engine with no spec", () => {
    const remoteEngine = engine({
      id: "claude-kimi",
      egress: "remote",
      kind: "agentic-cli",
      base_url: "https://api.kimi.com/coding/",
      secret: { service: "moonshot-api", username: "kimi-k2.7-code", header: "x-api-key" },
    });
    const reg = registry(config({ engines: [remoteEngine] }), newEnginesRoot());
    expect(reg.serves("claude-kimi")).toEqual(["/v1/chat/completions"]);
  });

  test("unknown id serves nothing rather than throwing", () => {
    const reg = registry(config({ engines: [] }), newEnginesRoot());
    expect(reg.serves("nope")).toEqual([]);
  });
});

describe("spec_source", () => {
  test("names the shipped directory when no spec_dir override is set", async () => {
    const { root, reg } = setupLlama();
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.spec_source).toBe(join(root, "llama"));
  });

  test("names the override directory when spec_dir wins", async () => {
    const root = newEnginesRoot();
    const overrideRoot = mkdtempSync(join(TEST_ROOT, "engined-override-"));
    writeFileSync(join(overrideRoot, "spec.toml"), PULLED_CONTAINER);
    const reg = registry(
      config({ engines: [engine({ id: "llama", spec_dir: overrideRoot })] }),
      root,
    );
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.spec_source).toBe(overrideRoot);
  });
});

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
    const argv = buildRunArgs("engined-comfy", spec, 8188);
    expect(argv).toContain("--preview-method");
    expect(argv).toContain("latent2rgb");
    expect(argv).toContain("/dev/kfd");
    expect(argv).toContain("/dev/dri");
    expect(argv).toContain("label=disable");
    expect(argv).not.toContain("-P");
    expect(argv.some((a) => a.startsWith("0.0.0.0::"))).toBe(false);
  });
});

function comfyExec(): Exec {
  let port = 40_000;
  return (args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      return Promise.resolve(inspectSinglePort(8188));
    }
    if (args[0] === "port") {
      return Promise.resolve(portResult(++port));
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
}

const READY_PROBE: Probe = () => Promise.resolve({ status: 200 });

const EMPTY_QUEUE: QueueSnapshot = { queue_running: [], queue_pending: [] };
const BUSY_QUEUE: QueueSnapshot = { queue_running: [{ id: "job-1" }], queue_pending: [] };

function comfyConfig(): Config {
  return config({
    engines: [engine({ id: "comfy", egress: "none", idle_stop_seconds: 0.05, ready_timeout_s: 5 })],
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
      async (reg) => {
        const started = await reg.start("comfy");
        expect(started.state).toBe("running");
        expect(started.private_url).not.toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = reg.get("comfy");
        expect(after?.state).toBe("installed");
        expect(after?.private_url).toBeNull();
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
      async (reg) => {
        const started = await reg.start("comfy");
        expect(started.state).toBe("running");

        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = reg.get("comfy");
        expect(after?.state).toBe("running");
        expect(after?.private_url).not.toBeNull();
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
        const first = await reg.start("comfy");
        await lifecycle.removeEngine("comfy");
        const second = await reg.start("comfy");

        expect(first.private_url).not.toBeNull();
        expect(second.private_url).not.toBeNull();
        expect(second.private_url).not.toBe(first.private_url);
      },
    );
  });
});

/** Image present at `containerPort`, a fresh host port per "port" lookup, capturing every "run" argv. */
function capturingExec(containerPort: number, runArgvCalls: string[][]): Exec {
  let port = 50_000;
  return (args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      return Promise.resolve(inspectSinglePort(containerPort));
    }
    if (args[0] === "start") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 }); // never already created: fall through to "run"
    }
    if (args[0] === "run") {
      runArgvCalls.push([...args]);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (args[0] === "port") {
      return Promise.resolve(portResult(++port));
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
}

/** A registry over one engine, its lifecycle wired to `capturingExec` so `runArgvCalls` fills in as `start()` runs it. */
function capturingRegistry(
  entry: EngineEntry,
  containerPort: number,
): { reg: EngineRegistry; runArgvCalls: string[][] } {
  const runArgvCalls: string[][] = [];
  const reg = new EngineRegistry(config({ engines: [entry] }), {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    lifecycle: new DockerLifecycle(capturingExec(containerPort, runArgvCalls), READY_PROBE),
  });
  return { reg, runArgvCalls };
}

describe("spec construction is routed through the per-engine builder", () => {
  test("comfy started through the registry carries its models bind mount in the run argv", async () => {
    const { reg, runArgvCalls } = capturingRegistry(
      engine({ id: "comfy", egress: "none", models_dir: "/data/comfy-models", ready_timeout_s: 5 }),
      8188,
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

  test("local-llama started through the registry carries --models-preset and its :ro mounts", async () => {
    // start() on an id shaped like local-llama renders the preset to
    // stateDir()/local-llama/preset.ini unconditionally (engines.ts's own
    // LOCAL_LLAMA_PRESET_PATH, not overridable via RegistryOptions) -- the
    // same path the real running engine has bind-mounted.
    const restoreStateHome = redirectStateHome();
    const { reg, runArgvCalls } = capturingRegistry(
      engine({
        id: "local-llama",
        egress: "none",
        models_dir: "/data/gguf",
        models_max: 3,
        ready_timeout_s: 5,
      }),
      8080,
    );
    try {
      await reg.start("local-llama");
      expect(runArgvCalls).toHaveLength(1);
      const [argv] = runArgvCalls;
      expect(argv).toContain("--models-preset");
      expect(argv?.some((a) => a === "/data/gguf:/models:ro")).toBe(true);
      expect(argv?.some((a) => a.includes("local-llama/preset.ini:/preset.ini:ro"))).toBe(true);
    } finally {
      await reg.shutdown();
      restoreStateHome();
    }
  });
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
        engines: [
          engine({ id: "whisper-like", egress: "none", args: { threads: 4 }, ready_timeout_s: 5 }),
        ],
      }),
      {
        enginesRoot: root,
        bunx: BUNX,
        lifecycle: new DockerLifecycle(capturingExec(8080, runArgvCalls), READY_PROBE),
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
            engines: [engine({ id: "kokoro-like", egress: "none", args: { foo: "bar" } })],
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
      config({ engines: [engine({ id: "kokoro-like", egress: "none", ready_timeout_s: 5 })] }),
      {
        enginesRoot: root,
        bunx: BUNX,
        lifecycle: new DockerLifecycle(capturingExec(8080, runArgvCalls), READY_PROBE),
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
 * `comfyExec` answers `inspect` with an empty stdout, which reconcile would
 * read as "gone" no matter what: liveness has to be stated for the transient
 * case to mean anything.
 */
function comfyExecLiveness(alive: boolean): Exec {
  const base = comfyExec();
  return (args) => {
    if (args[0] === "inspect") {
      return Promise.resolve({ stdout: `${alive}\n`, stderr: "", exitCode: 0 });
    }
    return base(args);
  };
}

function comfyLongIdleConfig(): Config {
  return config({
    engines: [engine({ id: "comfy", egress: "none", idle_stop_seconds: 60, ready_timeout_s: 5 })],
  });
}

describe("comfy: a container that dies underneath engined", () => {
  test("a refused /queue poll against a gone container clears the stale running state", async () => {
    await withComfyRegistry(
      {
        exec: comfyExecLiveness(false),
        cfg: comfyLongIdleConfig(),
        queueFetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
        comfyPollIntervalMs: 15,
      },
      async (reg) => {
        const started = await reg.start("comfy");
        expect(started.state).toBe("running");
        expect(started.private_url).not.toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 300));

        // Never a 200 naming a dead address: the door reports what docker says.
        const after = reg.get("comfy");
        expect(after?.state).toBe("installed");
        expect(after?.private_url).toBeNull();
      },
    );
  });

  test("a refused poll against a container still up leaves it running", async () => {
    await withComfyRegistry(
      {
        exec: comfyExecLiveness(true),
        cfg: comfyLongIdleConfig(),
        queueFetch: () => Promise.reject(new Error("socket hang up")),
        comfyPollIntervalMs: 15,
      },
      async (reg) => {
        expect((await reg.start("comfy")).state).toBe("running");

        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = reg.get("comfy");
        expect(after?.state).toBe("running");
        expect(after?.private_url).not.toBeNull();
      },
    );
  });
});
