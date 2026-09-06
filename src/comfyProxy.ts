/**
 * The mediated comfy proxy. `private_url` is a funding bypass: every control
 * this project has -- call recording, egress ceilings, and later the
 * budgets that decide whose money pays -- lives at the door, and a consumer
 * holding a raw container address routes around all of it. This is comfy's
 * replacement: every real caller reaches ComfyUI's own paths through here,
 * by address, and never by a host:port this door handed out. The rule is
 * simple even where the mediation below is not: the door forwards content,
 * never a ledger and never control.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { ComfyBindings, DoorContext } from "./doorContext.ts";
import {
  CONTENT_TYPE,
  type HttpClient,
  JSON_CONTENT_TYPE,
  jsonError,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_NOT_FOUND,
  STATUS_UNAVAILABLE,
} from "./http.ts";
import { stateDir } from "./paths.ts";
import { readJsonBody } from "./requestBody.ts";
import { errMessage, isRecord, parseRecord } from "./types.ts";

const COMFY_PROXY_RE = /^\/engined\/v1\/comfy\/([^/]+)\/([^/]+)\/(.+)$/;
export const COMFY_WS_SUFFIX = "ws";
/** Rewrites an `http(s)://` base to its `ws(s)://` twin for the comfy websocket bridge. */
const HTTP_SCHEME_RE = /^http/;
/** Enough of a UUID to keep two same-second uploads of one filename apart in comfy's shared input directory. */
const COMFY_UPLOAD_PREFIX_LEN = 12;

/** The three path segments `COMFY_PROXY_RE` captures. */
interface ComfyMatch {
  engineSeg: string;
  upstreamSeg: string;
  rest: string;
}

export function matchComfyPath(pathname: string): ComfyMatch | undefined {
  const m = COMFY_PROXY_RE.exec(pathname);
  return m
    ? { engineSeg: m[1] as string, upstreamSeg: m[2] as string, rest: m[3] as string }
    : undefined;
}

/** One resolved comfy engine plus the client every forwarded call goes through. */
interface ComfyProxy {
  ctx: DoorContext;
  engineId: string;
  /** Who submitted the prompt: half the binding key, so no rekey is needed the day a call arrives from somewhere other than this box. */
  origin: string;
  base: string;
  httpClient: HttpClient;
}

/** `ServerWebSocket.data` for one comfy relay connection: where to reach the real container, the door-assigned clientId comfy filters frames by, and the live upstream socket once `open` has dialed it. */
export interface ComfyWsData {
  upstreamUrl: string;
  clientId: string;
  upstream?: WebSocket;
}

/** `Bun.serve`'s own return type, parameterized on the one websocket payload this door ever mounts -- `bindDualFamily`'s real listeners and `Door.fetch`'s optional second argument must agree on it, or `server.upgrade`'s `data` stops typechecking. */
export type EnginedServer = ReturnType<typeof Bun.serve<ComfyWsData>>;

/** Every caller reaching this door reached it directly, so far; a federated hop will supply its own origin instead of this constant. */
const COMFY_LOCAL_ORIGIN = "local";

/** NUL, so the composed key stays unambiguous and `startsWith` can scope a scan to one (engine, origin) pair: no engine id, origin or `prompt_id` can contain one. */
const COMFY_KEY_SEP = "\u0000";

function comfyKey(engineId: string, origin: string, promptId: string): string {
  return `${engineId}${COMFY_KEY_SEP}${origin}${COMFY_KEY_SEP}${promptId}`;
}

/**
 * The binding table on disk: ids and filenames only, never a request body --
 * a `prompt_id` is comfy's job handle, not the prompt that produced it.
 * It outlives the process because a restart that forgot a binding would
 * refuse a stored output to the very caller that created it.
 */
function comfyBindingsPath(): string {
  return join(stateDir(), "comfy-bindings.json");
}

export function loadComfyBindings(): ComfyBindings {
  let text = "";
  try {
    text = readFileSync(comfyBindingsPath(), "utf8");
  } catch {
    // No table yet. An empty one refuses every stored output, which is the
    // safe direction to fail, and so is a file this build cannot read.
  }
  const raw = parseRecord(text);
  if (raw === null) {
    return new Map();
  }
  return new Map(
    Object.entries(raw).flatMap(([key, names]): [string, string[]][] =>
      Array.isArray(names) ? [[key, names.filter((n) => typeof n === "string")]] : [],
    ),
  );
}

/**
 * How many bindings the table keeps. Count, not age: a `prompt_id` carries no
 * timestamp and adding one would mean a second on-disk shape to read back,
 * where `Map` iteration order already puts the oldest binding first.
 *
 * Evicting a binding is what makes `GET /view` refuse an output the door
 * itself produced, so this is set well above what a session plausibly
 * generates rather than as tight as the file could bear -- ~78 bytes per
 * binding measured, so the whole table stays under ~100 KB.
 */
const COMFY_BINDINGS_MAX = 1000;

// ponytail: the whole table is rewritten on every bind and every filename
// this door had not already recorded -- bounded work now that
// COMFY_BINDINGS_MAX bounds the table. An append log only earns its
// complexity if that cap is ever raised far enough for the rewrite to be felt.
/**
 * The eviction lands only once the write has. A full disk or an unwritable
 * state dir would otherwise shrink the table in memory while the file keeps
 * the larger set, and the door would refuse an output it can still see on
 * disk with nothing said. So a failed write evicts nothing, leaving the
 * table a superset of what the file describes -- every binding the file
 * holds is still served, plus the ones that never reached it, which is the
 * direction that refuses nothing. The failure reports itself and the call it
 * belongs to still answers: the caller's own request succeeded, and only the
 * unwritten bindings are lost, at the next restart.
 */
function saveComfyBindings(bindings: ComfyBindings): void {
  // Oldest first: a binding is inserted when its prompt is queued and only
  // mutated in place afterwards, so insertion order is creation order.
  const entries = [...bindings];
  const evicted = entries.slice(0, Math.max(0, entries.length - COMFY_BINDINGS_MAX));
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      comfyBindingsPath(),
      JSON.stringify(Object.fromEntries(entries.slice(evicted.length))),
    );
  } catch (err) {
    process.stderr.write(`comfy bindings not persisted: ${errMessage(err)}\n`);
    return;
  }
  for (const [key] of evicted) {
    bindings.delete(key);
  }
}

interface ComfyTarget {
  engineId: string;
  /** `http://host:port`, this container's own address -- never handed to a caller, only used to build the door's own forwarded request. */
  base: string;
}

/** The engine+upstream segments of a comfy proxy path, resolved to a running comfy container -- `undefined` for anything that is not one: an unknown engine, a non-comfy kind, a route that does not exist, or a container that is not up. */
function resolveComfyTarget(
  ctx: DoorContext,
  engineSeg: string,
  upstreamSeg: string,
): ComfyTarget | undefined {
  const config = ctx.getConfig();
  if (!config.engines.some((e) => e.id === engineSeg)) {
    return undefined;
  }
  if (ctx.registry.get(engineSeg)?.kind !== "comfy") {
    return undefined;
  }
  const hasRoute = config.routes.some(
    (r) =>
      !r.disabled && r.engine === engineSeg && r.upstream === upstreamSeg && r.model === undefined,
  );
  if (!hasRoute) {
    return undefined;
  }
  const privateUrl = ctx.lifecycle.getStatus(engineSeg).private_url;
  return privateUrl === null ? undefined : { engineId: engineSeg, base: `http://${privateUrl}` };
}

function noSuchComfyEngine(engineSeg: string, upstreamSeg: string): Response {
  return jsonError(
    STATUS_UNAVAILABLE,
    `no running comfy engine at "@/${engineSeg}/${upstreamSeg}" -- start it first`,
  );
}

/** comfy's own status and body handed straight back, re-declared as JSON: the body is already read, so nothing but the door's own content type is imposed on it. */
function jsonForward(res: Response, text: string): Response {
  return new Response(text, { status: res.status, headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE } });
}

/** `GET /object_info/{nodeType}` and `GET /system_stats`: a static node schema and the container's own stats, nobody's data either way. */
async function forwardComfyGet(
  base: string,
  rest: string,
  search: string,
  httpClient: HttpClient,
): Promise<Response> {
  const res = await httpClient(`${base}/${rest}${search}`);
  return new Response(res.body, {
    status: res.status,
    headers: { [CONTENT_TYPE]: res.headers.get(CONTENT_TYPE) ?? JSON_CONTENT_TYPE },
  });
}

/** The `prompt_id` comfy answered `/prompt` with -- `undefined` for a body that is not JSON or carries none, which binds nothing. The caller still gets comfy's real body and status back either way. */
function comfyPromptId(text: string): string | undefined {
  const id = parseRecord(text)?.prompt_id;
  return typeof id === "string" ? id : undefined;
}

/** How often a held submission re-asks the container whether it has drained. A render is seconds to minutes, so a tighter poll buys nothing and costs a round trip. */
const COMFY_DRAIN_POLL_MS = 500;

/**
 * How long a submission waits for the container to drain when the engine does
 * not say. Not a render-length estimate: it is the ceiling that stops a wedged
 * container from parking every later submission on this door forever. A real
 * render that legitimately exceeds it answers 503 naming the engine and the
 * key to raise, which is recoverable; an unbounded wait is not.
 */
const COMFY_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

const MS_PER_SECOND = 1000;

/** This engine's own ceiling, or the default above. */
function comfyDrainTimeoutMs(ctx: DoorContext, engineId: string): number {
  const seconds = ctx.getConfig().engines.find((e) => e.id === engineId)?.drain_timeout_seconds;
  return seconds === undefined ? COMFY_DRAIN_TIMEOUT_MS : seconds * MS_PER_SECOND;
}

/**
 * Runs `fn` with this engine's submission gate held, so the read-then-act
 * sequences that decide what the container is holding cannot interleave.
 *
 * The chain is kept alive across a rejection deliberately: a handler that
 * throws must not reject every later holder of the same gate.
 */
function withComfySlot<T>(ctx: DoorContext, engineId: string, fn: () => Promise<T>): Promise<T> {
  const settled = () => undefined;
  const run = (ctx.comfySlots.get(engineId) ?? Promise.resolve()).then(fn, fn);
  ctx.comfySlots.set(engineId, run.then(settled, settled));
  return run;
}

/** Whether the container is holding nothing at all -- neither running nor queued. */
async function comfyDrained(base: string, httpClient: HttpClient): Promise<boolean> {
  const queue = await readComfyQueue(base, httpClient);
  if (queue === undefined) {
    return false;
  }
  return (
    queuedPromptIds(queue.queue_running).length === 0 &&
    queuedPromptIds(queue.queue_pending).length === 0
  );
}

/** `POST /prompt`, forwarded, with the returned `prompt_id` bound to this engine's proxy state -- the only thing that makes the `/history` and `/queue` mediation below possible. */
async function proxyComfyPrompt(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await req.text();
  const timeoutMs = comfyDrainTimeoutMs(ctx, engineId);
  const deadline = Date.now() + timeoutMs;
  // Compare-and-swap rather than one long hold: the gate is taken only for the
  // drain check and the forward that follows it, so a `/cancel` -- which is
  // how a caller ends the render this is waiting on -- is never queued behind
  // a submission that is waiting for that same render to end.
  while (Date.now() < deadline) {
    const forwarded = await withComfySlot(ctx, engineId, async () => {
      if (!(await comfyDrained(base, httpClient))) {
        return;
      }
      const res = await httpClient(`${base}/prompt`, {
        method: "POST",
        headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
        body,
      });
      const text = await res.text();
      const promptId = res.ok ? comfyPromptId(text) : undefined;
      if (promptId !== undefined) {
        ctx.comfyBindings.set(comfyKey(engineId, origin, promptId), []);
        saveComfyBindings(ctx.comfyBindings);
      }
      return jsonForward(res, text);
    });
    if (forwarded !== undefined) {
      return forwarded;
    }
    await Bun.sleep(COMFY_DRAIN_POLL_MS);
  }
  return jsonError(
    STATUS_UNAVAILABLE,
    `"@/${engineId}" has not been free for ${timeoutMs / MS_PER_SECOND}s and this door submits one prompt at a time -- cancel the running prompt, restart the engine, or raise its "drain_timeout_seconds"`,
  );
}

/** `POST /upload/image`, forwarded with the stored filename namespaced -- comfy's input directory is shared across every caller, and two callers uploading "reference.png" the same second must not silently overwrite one another. */
async function proxyComfyUpload(
  base: string,
  req: Request,
  httpClient: HttpClient,
): Promise<Response> {
  const incoming = await req.formData();
  const image = incoming.get("image");
  if (!(image instanceof Blob)) {
    return jsonError(STATUS_BAD_REQUEST, 'expected a multipart form with an "image" part');
  }
  const originalName = image instanceof File ? image.name : "upload.png";
  const namespaced = `${crypto.randomUUID().replace(/-/g, "").slice(0, COMFY_UPLOAD_PREFIX_LEN)}-${originalName}`;
  const outgoing = new FormData();
  // A fresh `Blob`, not the caller's own `File`: `FormData.append`'s third
  // argument only renames a plain Blob -- handed an existing File, it keeps
  // that File's own name, and the caller's literal filename would leak into
  // comfy's shared input directory unrenamed.
  outgoing.append("image", new Blob([await image.arrayBuffer()], { type: image.type }), namespaced);
  for (const [key, value] of incoming.entries()) {
    if (key !== "image" && typeof value === "string") {
      outgoing.append(key, value);
    }
  }
  const res = await httpClient(`${base}/upload/image`, { method: "POST", body: outgoing });
  return jsonForward(res, await res.text());
}

/**
 * Whether some prompt this origin submitted to this engine actually
 * produced `filename`. Scoped to the pair, never engine-wide: another
 * origin's `/history` read must not make its outputs viewable here.
 */
// ponytail: linear over the table, which COMFY_BINDINGS_MAX holds at a
// thousand entries; index by filename only if that cap is ever raised.
function comfyFilenameBound(
  ctx: DoorContext,
  engineId: string,
  origin: string,
  filename: string,
): boolean {
  const prefix = `${engineId}${COMFY_KEY_SEP}${origin}${COMFY_KEY_SEP}`;
  for (const [key, filenames] of ctx.comfyBindings) {
    if (key.startsWith(prefix) && filenames.includes(filename)) {
      return true;
    }
  }
  return false;
}

/** The one refusal `GET /view` ever answers with, for a filename this door never saw a completed job produce -- byte-identical whether that filename does not exist at all or simply was never surfaced to this caller, because this door checks its own known-filenames set and never comfy's disk either way. */
function comfyViewRefused(): Response {
  return jsonError(STATUS_NOT_FOUND, "unknown filename");
}

/**
 * `GET /view`, mediated: only a filename that a completed `/history` read
 * actually surfaced for THIS engine ever reaches comfy. The path-traversal
 * guard this delivery needs today, and the caller-ownership guard the
 * door's design is heading toward -- comfy's output directory is shared,
 * and a caller-supplied filename must never become a URL on its own say-so.
 */
async function proxyComfyView(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  params: URLSearchParams,
): Promise<Response> {
  const filename = params.get("filename");
  if (filename === null || !comfyFilenameBound(ctx, engineId, origin, filename)) {
    return comfyViewRefused();
  }
  const res = await httpClient(`${base}/view?${params.toString()}`);
  return new Response(res.body, {
    status: res.status,
    headers: { [CONTENT_TYPE]: res.headers.get(CONTENT_TYPE) ?? "application/octet-stream" },
  });
}

type ComfyHistoryEntry = Record<string, unknown>;

/** The media kinds a comfy node can emit an output filename under. */
const COMFY_MEDIA_KEYS = ["images", "gifs", "video"];

/** Every output filename one node emitted, across every media kind comfy can name one under. */
function filenamesInOutput(output: unknown): string[] {
  if (!isRecord(output)) {
    return [];
  }
  const names: string[] = [];
  for (const key of COMFY_MEDIA_KEYS) {
    const media = output[key];
    for (const item of Array.isArray(media) ? media : []) {
      if (isRecord(item) && typeof item.filename === "string") {
        names.push(item.filename);
      }
    }
  }
  return names;
}

/**
 * Every output filename a history entry names, across every node. `outputs`
 * is comfy's node-id table, so anything that is not one -- an array
 * included -- names nothing, and `/view` refuses what it never bound.
 */
function filenamesIn(entry: ComfyHistoryEntry | undefined): string[] {
  const outputs = entry?.outputs;
  return Object.values(isRecord(outputs) ? outputs : {}).flatMap(filenamesInOutput);
}

/** This prompt's entry in comfy's `/history` answer -- `undefined` for a body that is not the shape expected, which teaches nothing new. */
function comfyHistoryEntry(text: string, promptId: string): ComfyHistoryEntry | undefined {
  const entry = parseRecord(text)?.[promptId];
  return isRecord(entry) ? entry : undefined;
}

/**
 * `GET /history/{promptId}`, mediated: refused outright for a `promptId`
 * this door never bound via `/prompt` -- the bare form is the container's
 * entire global ledger, and even the scoped form would otherwise answer
 * with any other caller's completed job for a real id it did not itself
 * submit. A successful read seeds `filenames` with whatever this job
 * actually produced, which is what makes `/view` servable at all.
 */
async function proxyComfyHistory(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  promptId: string,
): Promise<Response> {
  const bound = ctx.comfyBindings.get(comfyKey(engineId, origin, promptId));
  if (bound === undefined) {
    return jsonError(STATUS_NOT_FOUND, `unknown prompt_id "${promptId}"`);
  }
  const res = await httpClient(`${base}/history/${encodeURIComponent(promptId)}`);
  const text = await res.text();
  if (res.ok) {
    // A client polling a running prompt reads the same entry over and over,
    // so the whole table is only rewritten when this read taught it something.
    const added = filenamesIn(comfyHistoryEntry(text, promptId)).filter(
      (filename) => !bound.includes(filename),
    );
    if (added.length > 0) {
      bound.push(...added);
      saveComfyBindings(ctx.comfyBindings);
    }
  }
  return jsonForward(res, text);
}

/** comfy's `GET /queue`: each entry is a positional tuple whose second slot is the `prompt_id`. */
const COMFY_QUEUE_PROMPT_ID_INDEX = 1;

function queuedPromptIds(entries: unknown): string[] {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => (Array.isArray(entry) ? entry[COMFY_QUEUE_PROMPT_ID_INDEX] : undefined))
    .filter((id): id is string => typeof id === "string");
}

async function readComfyQueue(
  base: string,
  httpClient: HttpClient,
): Promise<Record<string, unknown> | undefined> {
  const res = await httpClient(`${base}/queue`);
  return res.ok ? (parseRecord(await res.text()) ?? undefined) : undefined;
}

/**
 * `POST /cancel {prompt_id}` -- the door's own verb for stopping a prompt it
 * bound, and the whole reason `/interrupt` is never forwarded on its own.
 * comfy can only interrupt "whatever is running", carrying no id to scope
 * it; the door supplies the scoping the container lacks by reading the queue
 * itself -- never handing that ledger out -- and interrupting only once it
 * has confirmed the running prompt is the caller's own. A prompt the queue
 * read found still pending is dropped from the queue instead, which needs no
 * interrupt as long as it really was still pending, and one that has already
 * finished is reported as such rather than interrupting whatever inherited
 * the GPU after it. Either way the answer reports what the container did:
 * a refusal comes back as comfy's own status, never as a cancel this door
 * did not perform.
 *
 * Both of the windows this used to carry are closed, and by different means.
 *
 * An unscoped `/interrupt` could stop whichever job inherited the GPU from a
 * prompt that finished between the queue read and the interrupt. It cannot
 * now: `POST /prompt` holds submissions until the container has drained, so
 * nothing is ever queued behind the running prompt to inherit anything. The
 * interrupt either stops the caller's own prompt or arrives late and stops
 * nothing at all.
 *
 * A pending prompt that started rendering between the queue read and the
 * queue delete used to be reported "pending" while it held the GPU, because
 * comfy answers 200 to a delete that removed nothing. The delete is now
 * confirmed against a second queue read, and a prompt that slipped into
 * `queue_running` is interrupted and reported as what it became.
 *
 * The gate is held across the whole sequence, so a submission cannot enter
 * the container between this read and the act on it.
 */
async function proxyComfyCancel(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) {
    return body;
  }
  const promptId = body.prompt_id;
  if (typeof promptId !== "string") {
    return jsonError(STATUS_BAD_REQUEST, 'expected {"prompt_id": string}');
  }
  if (!ctx.comfyBindings.has(comfyKey(engineId, origin, promptId))) {
    return jsonError(STATUS_NOT_FOUND, `unknown prompt_id "${promptId}"`);
  }
  return withComfySlot(ctx, engineId, async () => {
    const queue = await readComfyQueue(base, httpClient);
    if (queue === undefined) {
      return jsonError(STATUS_BAD_GATEWAY, "comfy queue could not be read");
    }
    if (queuedPromptIds(queue.queue_running).includes(promptId)) {
      return interruptComfyRunning(base, httpClient, promptId);
    }
    if (queuedPromptIds(queue.queue_pending).includes(promptId)) {
      const dropped = await httpClient(`${base}/queue`, {
        method: "POST",
        headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
        body: JSON.stringify({ delete: [promptId] }),
      });
      if (!dropped.ok) {
        return jsonError(
          STATUS_BAD_GATEWAY,
          `comfy refused to drop "${promptId}" from its queue (http ${dropped.status})`,
        );
      }
      // comfy answers 200 whether or not the delete removed anything, so the
      // reply it earns is decided by what the queue says afterwards, never by
      // that status. A prompt that started rendering in the window between the
      // read above and this delete is still holding the GPU and is stopped
      // here rather than reported dropped.
      const after = await readComfyQueue(base, httpClient);
      if (after === undefined) {
        return jsonError(STATUS_BAD_GATEWAY, "comfy queue could not be read");
      }
      if (queuedPromptIds(after.queue_running).includes(promptId)) {
        return interruptComfyRunning(base, httpClient, promptId);
      }
      return Response.json({ prompt_id: promptId, cancelled: "pending" });
    }
    return Response.json({ prompt_id: promptId, cancelled: "finished" });
  });
}

/** The interrupt, and the one reply it earns. Safe to send unscoped because the submission gate keeps the container's pending queue empty: nothing can have inherited the GPU from the prompt named here. */
async function interruptComfyRunning(
  base: string,
  httpClient: HttpClient,
  promptId: string,
): Promise<Response> {
  const interrupted = await httpClient(`${base}/interrupt`, { method: "POST" });
  if (!interrupted.ok) {
    return jsonError(
      STATUS_BAD_GATEWAY,
      `comfy refused to interrupt "${promptId}" (http ${interrupted.status})`,
    );
  }
  return Response.json({ prompt_id: promptId, cancelled: "running" });
}

/** `POST /queue {delete:[promptId]}`, mediated: every id in the request must be one this door itself bound via `/prompt`, or nothing is forwarded -- the bare form is the container's global queue ledger, and even the delete form must not let a caller cancel a job it never submitted. */
async function proxyComfyQueueDelete(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) {
    return body;
  }
  if (!(Array.isArray(body.delete) && body.delete.every((id) => typeof id === "string"))) {
    return jsonError(STATUS_BAD_REQUEST, 'expected {"delete": string[]}');
  }
  const ids = body.delete as string[];
  if (!ids.every((id) => ctx.comfyBindings.has(comfyKey(engineId, origin, id)))) {
    return jsonError(STATUS_NOT_FOUND, "one or more prompt ids are not known to this door");
  }
  const res = await httpClient(`${base}/queue`, {
    method: "POST",
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
  });
  return jsonForward(res, await res.text());
}

/**
 * Everything else the container answers, dispatched by method and
 * sub-path. Every real call is sub-pathed (`/history/{id}`,
 * `/object_info/{type}`); matching the bare form would match nothing a real
 * caller ever sends and would only invite one that shouldn't. `GET /queue`
 * bare, `POST /free` and `POST /interrupt` are never forwarded: `/free`
 * evicts loaded weights (`release` is the door's own verb for that, with
 * the lease check that belongs there), `/interrupt` stops whatever the
 * container is CURRENTLY processing with no scoping of its own, and a bare
 * `/queue` is the container's entire global ledger. `POST /cancel` is the
 * door's own verb for the one those two would otherwise be wanted for: it
 * reads that ledger and interrupts on the caller's behalf, but only for a
 * `prompt_id` this door bound to this caller. Anything this door has
 * not explicitly allowlisted is refused the same way: the safe default is
 * to forward nothing at all.
 */
export function handleComfyProxy(
  ctx: DoorContext,
  req: Request,
  { engineSeg, upstreamSeg, rest }: ComfyMatch,
): Response | Promise<Response> {
  const target = resolveComfyTarget(ctx, engineSeg, upstreamSeg);
  if (target === undefined) {
    return noSuchComfyEngine(engineSeg, upstreamSeg);
  }
  const proxy: ComfyProxy = {
    ctx,
    engineId: target.engineId,
    origin: COMFY_LOCAL_ORIGIN,
    base: target.base,
    httpClient: ctx.doorOpts.comfyHttpClient ?? fetch,
  };

  if (rest === COMFY_WS_SUFFIX) {
    // A real upgrade never reaches here -- `fetch` intercepts it before
    // routing, using the live `Bun.serve` server it is handed. This is only
    // reached by a plain request against the ws path with no real socket
    // behind it (a unit test's direct `door.fetch` call), which cannot be
    // proxied at all.
    return jsonError(STATUS_BAD_REQUEST, "this path is a websocket upgrade, not a plain request");
  }
  let forwarded: Promise<Response> | undefined;
  if (req.method === "GET") {
    forwarded = comfyGet(proxy, rest, new URL(req.url));
  } else if (req.method === "POST") {
    forwarded = comfyPost(proxy, rest, req);
  }
  return forwarded ?? jsonError(STATUS_NOT_FOUND, `"${rest}" is not proxied by this door`);
}

function comfyGet(proxy: ComfyProxy, rest: string, url: URL): Promise<Response> | undefined {
  if (rest === "system_stats" || rest.startsWith("object_info/")) {
    return forwardComfyGet(proxy.base, rest, url.search, proxy.httpClient);
  }
  if (rest === "view") {
    return proxyComfyView(proxy, url.searchParams);
  }
  if (rest.startsWith("history/")) {
    return proxyComfyHistory(proxy, rest.slice("history/".length));
  }
  return undefined;
}

function comfyPost(proxy: ComfyProxy, rest: string, req: Request): Promise<Response> | undefined {
  if (rest === "prompt") {
    return proxyComfyPrompt(proxy, req);
  }
  if (rest === "upload/image") {
    return proxyComfyUpload(proxy.base, req, proxy.httpClient);
  }
  if (rest === "queue") {
    return proxyComfyQueueDelete(proxy, req);
  }
  if (rest === "cancel") {
    return proxyComfyCancel(proxy, req);
  }
  return undefined;
}

/**
 * `GET /ws?clientId=`, upgraded: the door mints its own `clientId` rather
 * than forwarding whatever the caller supplied -- comfy filters progress
 * frames by that id with no ownership check of its own, so a caller free to
 * choose it could subscribe to another caller's job. The assigned id is
 * announced back over the socket itself, as the first text frame
 * (`comfyWebSocketHandlers.open` below), because a websocket upgrade
 * response carries no body to hand it back any other way; a caller's later
 * `POST /prompt` must carry the same id as its own `client_id` for comfy to
 * correlate the two.
 */
export function handleComfyWsUpgrade(
  ctx: DoorContext,
  req: Request,
  server: EnginedServer,
  { engineSeg, upstreamSeg }: ComfyMatch,
): Response | undefined {
  const target = resolveComfyTarget(ctx, engineSeg, upstreamSeg);
  if (target === undefined) {
    return noSuchComfyEngine(engineSeg, upstreamSeg);
  }
  const clientId = crypto.randomUUID().replace(/-/g, "");
  const upstreamWsUrl = `${target.base.replace(HTTP_SCHEME_RE, "ws")}/ws?clientId=${clientId}`;
  const data: ComfyWsData = { upstreamUrl: upstreamWsUrl, clientId };
  return server.upgrade(req, { data })
    ? undefined
    : jsonError(STATUS_BAD_REQUEST, "websocket upgrade failed");
}

/** What `comfyWebSocketHandlers.open` announces first, so the caller learns the door-assigned `clientId` before it ever needs one for `POST /prompt`. */
const CLIENT_ID_MESSAGE_TYPE = "client_id";

/**
 * Bridges the caller's own upgraded socket to a fresh outbound connection to
 * the real container, one per caller connection. Comfy's own protocol is
 * server-to-client only (progress and preview frames); nothing a caller
 * could legitimately send back ever reaches comfy through this, so
 * `message` is a deliberate no-op.
 */
export const comfyWebSocketHandlers: Bun.WebSocketHandler<ComfyWsData> = {
  open(ws) {
    const upstream = new WebSocket(ws.data.upstreamUrl);
    upstream.binaryType = "arraybuffer";
    ws.data.upstream = upstream;
    upstream.addEventListener("open", () => {
      ws.send(
        JSON.stringify({ type: CLIENT_ID_MESSAGE_TYPE, data: { client_id: ws.data.clientId } }),
      );
    });
    upstream.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        ws.send(ev.data);
      } else {
        ws.send(new Uint8Array(ev.data as ArrayBuffer));
      }
    });
    upstream.addEventListener("close", () => ws.close());
    upstream.addEventListener("error", () => ws.close());
  },
  message() {
    // See the doc comment above: nothing a caller sends is ever forwarded.
  },
  close(ws) {
    ws.data.upstream?.close();
  },
};
