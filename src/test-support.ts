/**
 * Fixtures shared by every suite under `src/*.test.ts`: scratch-dir helpers,
 * object builders, and the exec-fake constants a container-spec test needs.
 * Kept to constants and small builders only -- never a mock, never a
 * fixture framework standing in for the real dependency under test.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "./exec.ts";
import { stateDir } from "./paths.ts";
import type { CallRecord } from "./provenance.ts";
import type { Config, EngineEntry, ModelEntry, ResolvedRoute, Upstream } from "./types.ts";

/** The bunx path every test spec is built against; never resolved from a real PATH. */
export const BUNX = "/home/x/.bun/bin/bunx";

/** The repo's real `engines/` dir, usable as an `enginesRoot` for a shipped-spec test. */
export const ENGINES_ROOT = join(import.meta.dir, "..", "engines");

/**
 * One mkdtemp root for every fixture a suite creates under it, removed once
 * in `afterAll` instead of each fixture leaking its own top-level temp dir.
 */
export function makeTestRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

export function engine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return { id: "e", args: {}, ...overrides };
}

/** A `[[model]]` capability row -- unrelated to any engine or upstream. See `route()` for the engine/upstream/model pairing. */
export function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return { id: "m", ...overrides };
}

/**
 * One `[[upstream]]`, resolved: where a route's bytes actually come from.
 * Egress is expressible only here (and on `route()`'s own `upstream` id,
 * which resolves against this) -- `loadConfig()` never produces an engine
 * carrying its own egress, so no fixture may either.
 */
export function upstream(overrides: Partial<Upstream> = {}): Upstream {
  return { id: "local", egress: "none", ...overrides };
}

/** One `[[route]]`, resolved: an engine paired with an upstream and, where one applies, a model. Defaults to the local llama shape most suites build against. */
export function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return { engine: "e", model: "m", upstream: "local", args: {}, ...overrides };
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    listen_port: 29_200,
    chat_timeout_seconds: 600,
    agent_timeout_seconds: 3600,
    models: [],
    engines: [],
    upstreams: [],
    routes: [],
    chains: {},
    ...overrides,
  };
}

/** A port nothing listens on: bind an ephemeral one and close it immediately. */
export function deadPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) {
    throw new Error("Bun.serve did not report a port");
  }
  return port;
}

/** A fresh `<root>/<id>/spec.toml` written with `content`; `root` stays usable as an `enginesRoot`. */
export function writeEngineSpec(root: string, id: string, content: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.toml"), content);
}

/** `LlamaRouter`'s default preset path is the real state dir; every test that reaches `ensureStarted()` redirects it here instead. */
export function tempPresetPath(root: string): string {
  return join(mkdtempSync(join(root, "engined-preset-")), "preset.ini");
}

export function collectLines(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

/**
 * The registry's proof gate persists to the real state directory, so a test
 * that proves an engine must clean up after itself the same way.
 */
export function clearVerifiedVersion(id: string): void {
  rmSync(join(stateDir(), "agentic", id), { recursive: true, force: true });
}

/** A `docker image inspect` success payload exposing exactly one container port. */
export function inspectSinglePort(containerPort: number | string): ExecResult {
  return {
    stdout: `[{"Config":{"ExposedPorts":{"${containerPort}/tcp":{}}}}]`,
    stderr: "",
    exitCode: 0,
  };
}

/** A `docker port` success payload: the host port docker bound for the query. */
export function portResult(hostPort: number | string): ExecResult {
  return { stdout: `127.0.0.1:${hostPort}\n`, stderr: "", exitCode: 0 };
}

/**
 * `docker inspect -f '{{.State.Running}}'`: the liveness read every reconcile
 * makes before believing its own record. A fake that let `run` succeed is
 * modelling a container that is up, and must say so — an unanswered inspect
 * reads as empty stdout, which is indistinguishable from "gone". Tests about
 * a container dying underneath engined pass `false`.
 */
export function containerRunning(alive = true): ExecResult {
  return { stdout: `${alive}\n`, stderr: "", exitCode: 0 };
}

interface BuildExecOptions {
  missingImages?: Set<string>;
  /** Exact `docker port` answer per container name -- for a test distinguishing two engines. */
  portByContainer?: Record<string, number>;
  /** One `docker port` answer for every container -- for a test with a single engine under test. */
  port?: number;
  /** `docker port` answers `portSeed + 1`, then `+ 2`, ... regardless of container: for a test that only needs each lookup to differ, never the value itself. */
  portSeed?: number;
  runLog?: string[][];
  stopLog?: string[][];
  /** Holds `run -d` pending this long before resolving -- a genuine tick for a start-lock race test to prove overlap against, not sequencing. */
  runDelayMs?: number;
}

/** Never asserted on directly: real host ports come from `portByContainer`, so this container port is an arbitrary placeholder. */
const PLACEHOLDER_CONTAINER_PORT = 80;

function execImageInspect(argv: string[], opts: BuildExecOptions): ExecResult {
  const [, , image] = argv;
  if (image !== undefined && opts.missingImages?.has(image)) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
  return inspectSinglePort(PLACEHOLDER_CONTAINER_PORT);
}

/** `portState.next`, when set, wins over both `port` and `portByContainer` -- an incrementing seed answers every lookup regardless of container. */
function execPort(
  argv: string[],
  opts: BuildExecOptions,
  portState: { next: number | undefined },
): ExecResult {
  if (portState.next !== undefined) {
    portState.next += 1;
    return portResult(portState.next);
  }
  if (opts.port !== undefined) {
    return portResult(opts.port);
  }
  const [, containerName] = argv;
  const port = containerName === undefined ? undefined : opts.portByContainer?.[containerName];
  return port === undefined ? { stdout: "", stderr: "", exitCode: 1 } : portResult(port);
}

async function execRun(argv: string[], opts: BuildExecOptions): Promise<ExecResult> {
  opts.runLog?.push(argv);
  if (opts.runDelayMs) {
    await Bun.sleep(opts.runDelayMs);
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

function execStop(argv: string[], opts: BuildExecOptions): ExecResult {
  opts.stopLog?.push(argv);
  return { stdout: "", stderr: "", exitCode: 0 };
}

/** One `Exec` shared by every container-spec engine in a test: dispatches on the image tag and the container name. */
export function buildExec(opts: BuildExecOptions): Exec {
  // Seeded here, not in `execPort`: the seed advances once per call and must
  // survive across calls, which a stateless helper can't hold.
  const portState = { next: opts.portSeed };
  return (args): Promise<ExecResult> => {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve(execImageInspect(argv, opts));
    }
    if (argv[0] === "start") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    }
    if (argv[0] === "run" && argv[1] === "-d") {
      return execRun(argv, opts);
    }
    if (argv[0] === "stop") {
      return Promise.resolve(execStop(argv, opts));
    }
    if (argv[0] === "port") {
      return Promise.resolve(execPort(argv, opts, portState));
    }
    if (argv[0] === "inspect") {
      return Promise.resolve(containerRunning());
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
}

/** The one provenance line a call emits, parsed. Fails loudly rather than yielding an empty object, so a missing line reads as a missing line. */
export function soleProvenanceRecord(lines: string[]): CallRecord {
  const [only, ...rest] = lines;
  // Thrown, not `expect`ed: this runs inside a helper rather than a test
  // body, and a throw fails the calling test just as loudly while naming the
  // lines it actually got.
  if (only === undefined || rest.length > 0) {
    throw new Error(
      `expected exactly one provenance line, got ${lines.length}: ${lines.join(" | ")}`,
    );
  }
  return JSON.parse(only);
}

/**
 * `model_reported` is what the engine echoed in the body; `model_resident` is
 * what its own `GET /v1/models` says answered. Asserting they DIFFER is the
 * point of every caller: equal values would pass a weaker check while proving
 * nothing about which of the two a field actually came from.
 */
export function assertReportedAndResident(
  lines: string[],
  reported: string,
  resident: string,
): void {
  if (reported === resident) {
    throw new Error(`the two values must differ to prove anything; both are "${reported}"`);
  }
  const { attempts } = soleProvenanceRecord(lines);
  const [only, ...rest] = attempts;
  if (only === undefined || rest.length > 0) {
    throw new Error(`expected exactly one attempt, got ${attempts.length}`);
  }
  if (only.model_reported !== reported || only.model_resident !== resident) {
    throw new Error(
      `expected reported "${reported}" / resident "${resident}", got "${only.model_reported}" / "${only.model_resident}"`,
    );
  }
}

/**
 * llama-server's control surface as router mode actually implements it:
 * `/models/load` accepts, `GET /v1/models` then reports that id as "loaded"
 * (the signal `loadAndWait` polls for -- an already-resident model's 400
 * "already running" fires before the child can serve, so it is not trusted),
 * and `/models/unload` acks.
 *
 * Returns undefined for every other path, which is the caller's own upstream
 * to answer. Each call gets its own closure, so two fakes never share
 * residency state.
 */
export function llamaControlPlane(): (url: string, init?: RequestInit) => Response | undefined {
  let lastLoadedModel: string | undefined;
  return (url, init) => {
    if (url.endsWith("/models/load")) {
      if (typeof init?.body === "string") {
        lastLoadedModel = (JSON.parse(init.body) as { model?: string }).model;
      }
      return Response.json({ success: true });
    }
    if (url.endsWith("/models/unload")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({
        data:
          lastLoadedModel === undefined
            ? []
            : [{ id: lastLoadedModel, status: { value: "loaded" } }],
      });
    }
  };
}

/**
 * A real `Bun.serve` on an ephemeral port, for a suite that needs an upstream
 * to actually be reached rather than substituted. `base` always carries its
 * scheme and `port` is the number, so no caller has to take one apart to get
 * the other; `requestLog` records each pathname, which is what proves an
 * engine was -- or was never -- reached.
 */
export function startFakeUpstream(fetchImpl: (req: Request) => Response | Promise<Response>): {
  base: string;
  port: number;
  requestLog: string[];
  stop: () => void;
} {
  const requestLog: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requestLog.push(new URL(req.url).pathname);
      return fetchImpl(req);
    },
  });
  // `port` is optional on Bun's Server (a unix-socket server has none); a
  // port: 0 listener always has one.
  const port = server.port ?? 0;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    requestLog,
    stop: () => {
      server.stop(true);
    },
  };
}
