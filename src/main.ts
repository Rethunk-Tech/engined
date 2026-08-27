/**
 * The door: `Bun.serve` bound on both loopback families, the Origin/Host
 * check every request passes through first, and the OpenAI-shaped routes.
 * `createDoor` is the testable half — request handling and SIGHUP reload
 * with no socket involved; the `import.meta.main` block below is the actual
 * process: binds, signal handlers, and the fatal-at-startup exit.
 */

import process from "node:process";
import { loadConfig } from "./config.ts";
import { resolveModel } from "./dispatch.ts";
import { EngineRegistry, type RegistryOptions } from "./engines.ts";
import { configPath, installDir } from "./paths.ts";
import { type Config, FatalError } from "./types.ts";

const CONTENT_ENDPOINTS = new Set([
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
]);

const START_RE = /^\/v1\/engines\/([^/]+)\/start$/;

/** As `URL#hostname` reports them: no port; an IPv6 literal keeps its brackets. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function refuse(message: string): Response {
  return Response.json({ error: message }, { status: 403 });
}

function isLoopbackHost(hostHeader: string, port: number): boolean {
  try {
    const url = new URL(`http://${hostHeader}`);
    const effectivePort = url.port === "" ? "80" : url.port;
    return LOOPBACK_HOSTNAMES.has(url.hostname) && effectivePort === String(port);
  } catch {
    return false;
  }
}

/**
 * Every endpoint including reads, before routing. Any `Origin` header at all
 * is refused — including the literal string `"null"` — because engined never
 * allowlists a consumer's origin: the one browser consumer (sagaforge's
 * settings page) reaches engined through the daemon it already talks to, and
 * a request with no `Origin` (every CLI and server consumer) is unaffected.
 */
function checkOrigin(req: Request, port: number): Response | null {
  if (req.headers.get("Origin") !== null) {
    return refuse("cross-origin requests are refused");
  }
  const host = req.headers.get("Host");
  if (host !== null && !isLoopbackHost(host, port)) {
    return refuse(`Host "${host}" is outside the loopback set`);
  }
  return null;
}

async function handleEngines(
  registry: EngineRegistry,
  configErr: string | undefined,
): Promise<Response> {
  const listed = await registry.list();
  if (configErr === undefined) {
    return Response.json(listed);
  }
  return Response.json({ ...listed, config_error: configErr });
}

async function handleStart(registry: EngineRegistry, id: string): Promise<Response> {
  try {
    return Response.json(await registry.start(id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 404 });
  }
}

async function handleContent(
  req: Request,
  pathname: string,
  config: Config,
  registry: EngineRegistry,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const model = typeof body.model === "string" ? body.model : undefined;
  const resolved = resolveModel(model, pathname, config, registry);
  if (!resolved.ok) {
    return Response.json({ error: resolved.error }, { status: 400 });
  }
  // Proxying to the resolved engine lands in a later phase.
  return Response.json({ error: "not yet implemented", resolved }, { status: 501 });
}

export interface Door {
  fetch: (req: Request) => Response | Promise<Response>;
  /** Re-reads `path`. Invalid TOML keeps the running config and records the error. */
  reload: (path: string) => void;
  registry: EngineRegistry;
  configError: () => string | undefined;
}

export function createDoor(initialConfig: Config, registryOpts: RegistryOptions): Door {
  let config = initialConfig;
  let configErr: string | undefined;
  const registry = new EngineRegistry(config, registryOpts);

  function reload(path: string): void {
    try {
      const next = loadConfig(path);
      config = next;
      configErr = undefined;
      registry.reload(next);
    } catch (err) {
      configErr = err instanceof Error ? err.message : String(err);
    }
  }

  function routeGet(pathname: string): Response | Promise<Response> | undefined {
    if (pathname === "/v1/models") {
      return Response.json(registry.models());
    }
    if (pathname === "/v1/engines") {
      return handleEngines(registry, configErr);
    }
  }

  function routePost(req: Request, pathname: string): Response | Promise<Response> | undefined {
    const startMatch = START_RE.exec(pathname);
    if (startMatch) {
      const [, id] = startMatch;
      return id === undefined
        ? Response.json({ error: "not found" }, { status: 404 })
        : handleStart(registry, id);
    }
    if (CONTENT_ENDPOINTS.has(pathname)) {
      return handleContent(req, pathname, config, registry);
    }
  }

  function route(req: Request): Response | Promise<Response> {
    const { pathname } = new URL(req.url);
    let matched: Response | Promise<Response> | undefined;
    if (req.method === "GET") {
      matched = routeGet(pathname);
    } else if (req.method === "POST") {
      matched = routePost(req, pathname);
    }
    return matched ?? Response.json({ error: "not found" }, { status: 404 });
  }

  function fetch(req: Request): Response | Promise<Response> {
    return checkOrigin(req, config.listen_port) ?? route(req);
  }

  return { fetch, reload, registry, configError: () => configErr };
}

if (import.meta.main) {
  let startupConfig: Config;
  try {
    startupConfig = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  // Set by the --user unit; a bare `bunx` is only reached in a working-tree dev run.
  const bunx = process.env.ENGINED_BUNX ?? "bunx";
  const door = createDoor(startupConfig, {
    enginesRoot: `${installDir()}/engines`,
    bunx,
  });

  let v4: ReturnType<typeof Bun.serve>;
  let v6: ReturnType<typeof Bun.serve>;
  try {
    v4 = Bun.serve({ hostname: "127.0.0.1", port: startupConfig.listen_port, fetch: door.fetch });
    v6 = Bun.serve({ hostname: "::1", port: v4.port, fetch: door.fetch });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  process.on("SIGHUP", () => door.reload(configPath()));

  process.on("SIGTERM", () => {
    door.registry
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        v4.stop();
        v6.stop();
        process.exit(0);
      });
  });
}
