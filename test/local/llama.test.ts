import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import process from "node:process";
import { loadConfig } from "../../src/config.ts";
import { DockerLifecycle, dockerExec } from "../../src/docker.ts";
import { LlamaRouter, type LlamaRouterOptions } from "../../src/llama.ts";
import { loadSpec } from "../../src/spec.ts";
import {
  type EngineEntry,
  isContainerSpec,
  type ResolvedRoute,
  type Role,
} from "../../src/types.ts";
import { requireNoResidentEngine, TEST_NAME_PREFIX } from "./exclusive.ts";

/**
 * Drives the real `LlamaRouter` against local-llama's real container and
 * the real GGUFs under its `models_dir` -- `config.example.toml` is loaded
 * as-is (no path swap) precisely because it is this operator's own real
 * config, so a clean parse here is also a live proof the example still
 * matches the real model tree.
 *
 * The image tag is read from the real `engines/local-llama/spec.toml` via
 * `loadSpec`, not hardcoded: that tag already drifted once within this
 * session (sagaforge-llama-cpp:local -> engined-llama-cpp:local, when
 * local-llama got its own vendored Dockerfile), and the old tag is STILL a
 * real image on this box -- a hardcoded copy here would not fail loudly on
 * a rename, it would quietly run green against the wrong artifact.
 *
 * Closes local-tier gaps the Opus audit found unverifiable: concurrent
 * cross-role decode, single-owner-under-load, embedding co-residency and
 * vector shape (first describe block), and a same-role swap proven from the
 * real child's own `/proc/<pid>/cmdline` rather than the rendered preset
 * file (second describe block).
 */
const LOCAL = process.env.ENGINED_LOCAL === "1";
const ENGINES_ROOT = join(import.meta.dir, "..", "..", "engines");
const CONFIG_EXAMPLE = join(import.meta.dir, "..", "..", "config.example.toml");
// {bunx} never appears in local-llama's own command; only agentic specs
// substitute it, so any non-empty string satisfies LlamaBuildOptions here.
const BUNX = process.env.ENGINED_BUNX ?? "bunx";
const READY_TIMEOUT_S = 240;
const IDLE_STOP_SECONDS = 900;
const POLL_INTERVAL_MS = 500;
const TEST_TIMEOUT_MS = 240_000;
const EMBEDDING_DIMENSIONS = 1024;

function imageBuilt(image: string): boolean {
  return Bun.spawnSync(["docker", "image", "inspect", image]).exitCode === 0;
}

interface Fixture {
  engine: EngineEntry;
  routes: ResolvedRoute[];
  image?: string;
  error?: string;
}

const EMPTY_ENGINE: EngineEntry = { id: "local-llama", egress: "none", args: {} };

/**
 * `loadSpec` needs `{models_max}` and `{preset_ini}` resolved to substitute
 * cleanly -- "/unused" and the real configured models_max (borrowed from
 * `engine`) satisfy the placeholders without needing a real router build;
 * only `.image` is read back.
 */
function specImage(engine: EngineEntry): string | undefined {
  try {
    const loaded = loadSpec(engine, {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
      presetIni: "/unused",
    });
    return isContainerSpec(loaded.spec) ? loaded.spec.image : undefined;
  } catch {
    // Spec parse failure, or an unresolved placeholder: undefined falls through to a clean skip.
  }
}

/**
 * Loaded once at module scope, guarded by `LOCAL` so an ordinary `bun test`
 * (which never imports this directory) and a `bun test test/local` run with
 * `ENGINED_LOCAL` unset both skip the real filesystem/docker probing below
 * entirely, not just the tests themselves.
 */
function loadFixture(): Fixture {
  if (!LOCAL) {
    return { engine: EMPTY_ENGINE, routes: [] };
  }
  try {
    const config = loadConfig(CONFIG_EXAMPLE, ENGINES_ROOT);
    const engine = config.engines.find((e) => e.id === "local-llama");
    const routes = config.routes.filter(
      (r) => r.engine === "local-llama" && r.upstream === "local",
    );
    if (!engine) {
      return {
        engine: EMPTY_ENGINE,
        routes: [],
        error: "config.example.toml has no local-llama engine",
      };
    }
    return { engine, routes, image: specImage(engine) };
  } catch (err) {
    return {
      engine: EMPTY_ENGINE,
      routes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const FIXTURE = loadFixture();
const CONTAINER_NAME = `${TEST_NAME_PREFIX}${FIXTURE.engine.id}`;
const HAVE_IMAGE = LOCAL && FIXTURE.image !== undefined && imageBuilt(FIXTURE.image);
const HAVE_MODELS = FIXTURE.error === undefined && FIXTURE.routes.length === 3;
const READY = LOCAL && HAVE_IMAGE && HAVE_MODELS;

// Module scope, guarded by READY: it must fire only when these tests would
// really drive containers, and it must be loud rather than another clean skip.
if (READY) {
  requireNoResidentEngine();
}

function skipReason(): string {
  if (FIXTURE.image === undefined) {
    return `local-llama's spec.toml did not resolve an image -- ${FIXTURE.error ?? "check engines/local-llama/spec.toml"}`;
  }
  if (!HAVE_IMAGE) {
    return `${FIXTURE.image} is not built -- see engines/local-llama for the build command`;
  }
  if (FIXTURE.error !== undefined) {
    return `config.example.toml did not load cleanly: ${FIXTURE.error}`;
  }
  return `expected exactly 3 local-llama routes (chat, vision, embedding) in config.example.toml, found ${FIXTURE.routes.length}`;
}

function describeTitle(base: string): string {
  return READY ? base : `${base}: SKIPPED -- ${skipReason()}`;
}

/** A route for `role` that actually names a model -- narrowed once here so every caller below reads `.model` as a plain string, never `string | undefined`. */
function findRoleRoute(
  routes: readonly ResolvedRoute[],
  role: Role,
): (ResolvedRoute & { model: string }) | undefined {
  return routes.find(
    (r): r is ResolvedRoute & { model: string } => r.role === role && r.model !== undefined,
  );
}

const CHAT = findRoleRoute(FIXTURE.routes, "chat");
const VISION = findRoleRoute(FIXTURE.routes, "vision");
const EMBED = findRoleRoute(FIXTURE.routes, "embedding");

function buildRouter(
  engine: EngineEntry,
  routes: ResolvedRoute[],
  presetFile: string,
  lifecycle: DockerLifecycle,
): LlamaRouter {
  const opts: LlamaRouterOptions = {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    idleStopSeconds: IDLE_STOP_SECONDS,
    readyTimeoutS: READY_TIMEOUT_S,
    presetHostPath: join(import.meta.dir, presetFile),
    pollIntervalMs: POLL_INTERVAL_MS,
  };
  return new LlamaRouter(engine, routes, lifecycle, opts);
}

async function containerCmdlines(): Promise<string[]> {
  const res = await dockerExec([
    "exec",
    CONTAINER_NAME,
    "sh",
    "-c",
    "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$f\"; echo; done",
  ]);
  return res.stdout.split("\n").filter((line) => line.trim().length > 0);
}

async function runningContainerCount(): Promise<number> {
  const res = await dockerExec([
    "ps",
    "--filter",
    `name=^${CONTAINER_NAME}$`,
    "--format",
    "{{.ID}}",
  ]);
  return res.stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Samples `runningContainerCount()` every `POLL_INTERVAL_MS` until `work` settles; returns every sample seen. */
async function sampleContainerCountDuring<T>(
  work: Promise<T>,
): Promise<{ result: T; samples: number[] }> {
  const samples: number[] = [];
  const timer = setInterval(() => {
    runningContainerCount().then((n) => samples.push(n));
  }, POLL_INTERVAL_MS);
  try {
    const result = await work;
    return { result, samples };
  } finally {
    clearInterval(timer);
  }
}

interface Timed<T> {
  start: number;
  end: number;
  value: T;
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = Date.now();
  const value = await fn();
  return { start, end: Date.now(), value };
}

/** Genuine wall-clock overlap: impossible if a shared lock forced one request to fully finish before the other's HTTP call began. */
function overlaps(a: Timed<unknown>, b: Timed<unknown>): boolean {
  return a.start < b.end && b.start < a.end;
}

function chatCompletionBody(modelId: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [{ role: "user", content: "Reply with the single word: hi" }],
    max_tokens: 8,
  });
}

async function proxyStatus(
  router: LlamaRouter,
  route: ResolvedRoute,
  path: string,
  body: string,
): Promise<number> {
  const { response: res } = await router.proxy(route, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return res.status;
}

interface EmbeddingResponse {
  status: number;
  body: { data?: { embedding?: number[] }[] };
}

async function proxyEmbedding(
  router: LlamaRouter,
  route: ResolvedRoute & { model: string },
): Promise<EmbeddingResponse> {
  const { response: res } = await router.proxy(route, "/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: route.model, input: "hello world" }),
  });
  return { status: res.status, body: (await res.json()) as EmbeddingResponse["body"] };
}

describe.skipIf(!READY)(describeTitle("local-llama router (local)"), () => {
  const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX);
  const router = buildRouter(FIXTURE.engine, FIXTURE.routes, ".scratch-preset.ini", lifecycle);

  afterAll(async () => {
    await lifecycle.shutdown();
  });

  test(
    "chat, vision and embedding are resident and answering concurrently, under exactly one container, and the embedding vector is 1024-wide",
    async () => {
      if (!(CHAT && VISION && EMBED)) {
        throw new Error(
          "fixture is missing one of chat/vision/embedding -- READY should have been false",
        );
      }

      const { result, samples } = await sampleContainerCountDuring(
        Promise.all([
          timed(() =>
            proxyStatus(router, CHAT, "/v1/chat/completions", chatCompletionBody(CHAT.model)),
          ),
          timed(() =>
            proxyStatus(router, VISION, "/v1/chat/completions", chatCompletionBody(VISION.model)),
          ),
          timed(() => proxyEmbedding(router, EMBED)),
        ]),
      );
      const [chatResult, visionResult, embedResult] = result;

      expect(chatResult.value).toBe(200);
      expect(visionResult.value).toBe(200);
      expect(embedResult.value.status).toBe(200);
      // Two role-independent leases genuinely overlapped in wall-clock time.
      expect(overlaps(chatResult, visionResult)).toBe(true);
      // No second `engined-local-llama` container ever existed transiently
      // under concurrent cross-role load, not just that none exists after.
      expect(Math.max(...samples)).toBe(1);

      const vector = embedResult.value.body.data?.[0]?.embedding;
      expect(vector).toBeDefined();
      expect(vector?.length).toBe(EMBEDDING_DIMENSIONS);
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * Two synthetic `[[model]]` entries pointed at the SAME real chat GGUF
 * (`CHAT.filename`) under different ids and different `[model.args]` --
 * proving the swap mechanism and the args-reach-argv claim needs two
 * distinct resident ids to swap between, not two distinct multi-gigabyte
 * downloads. What is under test is the swap machinery and the args
 * substitution, not this particular GGUF's content.
 *
 * The varying flag is `spec-draft-p-min` because it is visible in the
 * child's argv under a name the router rewrites (`--draft-p-min`), so
 * asserting on it catches a preset that reached the child by luck rather
 * than through the substitution under test. This exact GGUF is already
 * MTP-capable and already runs with `spec-type = "draft-mtp"` in production
 * (`config.example.toml`'s real `ornith` model), so the flag lands here
 * without a second multi-gigabyte download.
 */
const SWAP_PMIN_A = 0.15;
const SWAP_PMIN_B = 0.35;

type SwapRoute = ResolvedRoute & { model: string; filename: string };

function swapModels(): [SwapRoute, SwapRoute] | undefined {
  if (!CHAT || CHAT.filename === undefined) {
    return;
  }
  const base = {
    engine: "local-llama",
    upstream: "local" as const,
    filename: CHAT.filename,
    role: "chat" as const,
    aliases: [] as string[],
  };
  const specArgs = (pMin: number) => ({
    "spec-type": "draft-mtp",
    "spec-draft-p-min": pMin,
    "spec-draft-n-max": 1,
  });
  return [
    { ...base, model: "engined-local-test-swap-a", args: specArgs(SWAP_PMIN_A) },
    { ...base, model: "engined-local-test-swap-b", args: specArgs(SWAP_PMIN_B) },
  ];
}

/**
 * `--draft-p-min`, not `--spec-draft-p-min`: the router rewrites the INI
 * key to llama-server's short alias on the child's real argv (confirmed via
 * `/proc/<pid>/cmdline` -- `--spec-draft-n-max` and `--spec-type` come
 * through unrewritten on the same child, so this is per-flag, not a
 * blanket `spec-`-prefix drop). Checking the INI spelling here would repeat
 * the exact mistake the rendered-preset-is-not-proof rule exists to catch.
 */
function argvHasSpecPMin(lines: string[], value: number): boolean {
  return lines.some((line) => line.includes("--draft-p-min") && line.includes(String(value)));
}

describe.skipIf(!READY)(describeTitle("local-llama router: same-role swap (local)"), () => {
  const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX);
  const models = swapModels() ?? [];
  const router = buildRouter(FIXTURE.engine, models, ".scratch-preset-swap.ini", lifecycle);

  afterAll(async () => {
    await lifecycle.shutdown();
  });

  test(
    "swapping the chat-role resident unloads the prior one, the listing shows at most one loaded, and the real child argv changes",
    async () => {
      const [modelA, modelB] = models;
      if (!(modelA && modelB)) {
        throw new Error("swap fixture is missing -- READY should have been false");
      }

      expect(
        await proxyStatus(router, modelA, "/v1/chat/completions", chatCompletionBody(modelA.model)),
      ).toBe(200);
      expect(router.residentModel("chat")).toBe(modelA.model);
      expect(argvHasSpecPMin(await containerCmdlines(), SWAP_PMIN_A)).toBe(true);

      expect(
        await proxyStatus(router, modelB, "/v1/chat/completions", chatCompletionBody(modelB.model)),
      ).toBe(200);
      expect(router.residentModel("chat")).toBe(modelB.model);

      // Independent of the router's own bookkeeping: the engine's own
      // /v1/models listing, read fresh, shows the new one loaded and the old
      // one NOT loaded -- "at most one GGUF per role", not "the router
      // thinks it swapped".
      expect(await router.residentModelId("chat")).toBe(modelB.model);

      // The rendered preset file is not proof, the real
      // child's argv is. Re-read after the swap -- a relabelled bookkeeping
      // entry over the same unchanged process would still show the OLD value.
      const argvAfterB = await containerCmdlines();
      expect(argvHasSpecPMin(argvAfterB, SWAP_PMIN_B)).toBe(true);
      expect(argvHasSpecPMin(argvAfterB, SWAP_PMIN_A)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
