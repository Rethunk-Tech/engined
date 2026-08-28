/**
 * The llama.cpp extras proxy. In router mode, `/tokenize`, `/detokenize`,
 * `/apply-template` and a bare `GET /slots` 400 with "model name is missing
 * from the request" unless a model is named — sagaforge's own consumers of
 * these endpoints send none, so the injection is the entire feature, not a
 * passthrough. `/slots/:id`, `/models/load` and `/models/unload` already
 * name what they need and pass through untouched.
 */
import type { HttpClient } from "./llama.ts";
import { errMessage, isRecord } from "./types.ts";

const BODY_INJECT_PATHS = new Set(["/tokenize", "/detokenize", "/apply-template"]);

/** Throws on a malformed body so the caller answers 400 rather than letting it surface as a 500. */
function injectModel(bodyText: string | undefined, model: string): string {
  if (bodyText === undefined) {
    return JSON.stringify({ model });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new SyntaxError("request body is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new SyntaxError("request body must be a JSON object");
  }
  return JSON.stringify(parsed.model === undefined ? { ...parsed, model } : parsed);
}

/**
 * Forwards one extras request to the resident llama-server, injecting the
 * resident model where router mode requires one. The response is returned
 * exactly as the upstream sent it -- no buffering, no reparsing -- so an SSE
 * body's `timings`/`timings_per_token` fields reach the caller unmodified.
 */
export async function proxyExtras(
  req: Request,
  baseUrl: string,
  residentModel: string | null,
  httpClient: HttpClient = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body = hasBody ? await req.text() : undefined;
  if (residentModel !== null && hasBody && BODY_INJECT_PATHS.has(url.pathname)) {
    try {
      body = injectModel(body, residentModel);
    } catch (err) {
      return Response.json({ error: errMessage(err) }, { status: 400 });
    }
  }

  const target = new URL(url.pathname + url.search, baseUrl);
  if (
    residentModel !== null &&
    url.pathname === "/slots" &&
    req.method === "GET" &&
    !target.searchParams.has("model")
  ) {
    target.searchParams.set("model", residentModel);
  }

  return httpClient(target.toString(), {
    method: req.method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body,
  });
}
