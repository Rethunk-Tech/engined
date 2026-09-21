/**
 * A Cursor-protocol door, so `cursor-agent --endpoint <this door>` runs a
 * turn on this box's own GPU instead of Cursor's cloud.
 *
 * The CLI speaks Connect RPC over the `aiserver.v1` and `agent.v1` services.
 * Three things make serving it tractable:
 *
 * - It boots through a fixed chain of unary calls, and every one of them
 *   except the three model lookups is satisfied by an empty message.
 * - `AgentService/Run` is bidirectional and would need HTTP/2, but the client
 *   maps it to the server-streaming `RunSSE` whenever it is told to use
 *   HTTP/1.1 -- which this door does, via `GetServerConfig`.
 * - A turn arrives in two parts: `BidiService/BidiAppend` carries the content
 *   as a hex-encoded nested message, then `RunSSE` opens the stream carrying
 *   only the request id that ties the two together.
 *
 * Schemas were recovered with `scripts/cursor-proto-extract.py`; the field
 * numbers below are that tool's output, not guesses.
 */

import {
  bytesField,
  decode,
  ENVELOPE_HEADER,
  endOfStream,
  envelope,
  type Field,
  fieldBytes,
  fieldString,
  intField,
  message,
  stringField,
} from "./cursorProto.ts";
import type { DoorContext } from "./doorContext.ts";

const AISERVER_PREFIX = "/aiserver.v1.";
const AGENT_PREFIX = "/agent.v1.";
const CONNECT_STREAM_TYPE = "application/connect+proto";
const PROTO_TYPE = "application/proto";

/**
 * `GetServerConfigResponse.http2_config`. `FORCE_ALL_DISABLED` is what makes
 * the client pick its HTTP/1.1 transport, and with it the `RunSSE` mapping
 * this door can actually serve. Without it the CLI opens an HTTP/2 session
 * and drops the connection against a 1.1 server.
 */
const HTTP2_FORCE_ALL_DISABLED = 1;
const HTTP2_CONFIG_FIELD = 7;

/** `InteractionUpdate` field numbers. */
const UPDATE_TEXT_DELTA = 1;
const UPDATE_TURN_ENDED = 14;

/**
 * A turn arrives as two requests that name the same id, and `RunSSE` opens
 * FIRST -- the stream is already waiting when `BidiAppend` delivers the text.
 * So a turn is a promise either side may create: whichever request arrives
 * first makes the slot, the other settles or consumes it. Holding the stream
 * open is the whole point; answering `RunSSE` before the content lands is how
 * an empty turn gets served.
 */
interface Turn {
  text: Promise<string>;
  deliver: (text: string) => void;
}

const TURNS = new Map<string, Turn>();
const TURNS_MAX = 64;
const TURN_WAIT_MS = 30_000;

function turnFor(requestId: string): Turn {
  const existing = TURNS.get(requestId);
  if (existing !== undefined) {
    return existing;
  }
  if (TURNS.size >= TURNS_MAX) {
    const oldest = TURNS.keys().next().value;
    if (oldest !== undefined) {
      TURNS.delete(oldest);
    }
  }
  let deliver: ((text: string) => void) | undefined;
  const text = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  const turn: Turn = { text, deliver: deliver ?? ((): void => undefined) };
  TURNS.set(requestId, turn);
  return turn;
}

export function isCursorPath(pathname: string): boolean {
  return pathname.startsWith(AISERVER_PREFIX) || pathname.startsWith(AGENT_PREFIX);
}

function protoResponse(body: Uint8Array): Response {
  return new Response(body as BodyInit, {
    status: 200,
    headers: { "content-type": PROTO_TYPE },
  });
}

/** Every llama chat route on this box, by the name a caller addresses it as. */
function chatModels(ctx: DoorContext): string[] {
  return ctx
    .getConfig()
    .routes.filter((r) => r.role === "chat" && r.model !== undefined && r.disabled !== true)
    .map((r) => r.model as string);
}

/**
 * `AvailableModelsResponse`, `GetUsableModelsResponse` and
 * `GetDefaultModelForCliResponse` are three different shapes carrying the
 * same list, and the CLI reads all three: answering only the first leaves its
 * picker empty with "Cannot use this model".
 */
function availableModels(models: string[]): Uint8Array {
  const rows = models.map((name) =>
    bytesField(
      2,
      message(
        stringField(1, name),
        intField(2, 1), // default_on
        intField(5, 1), // supports_agent
        intField(22, 1), // supports_plan_mode
      ),
    ),
  );
  return message(...rows, ...models.map((name) => stringField(1, name)));
}

function modelDetails(models: string[]): Uint8Array {
  return message(...models.map((name) => bytesField(1, message(stringField(1, name)))));
}

function defaultModel(models: string[]): Uint8Array {
  const first = models[0];
  return first === undefined ? new Uint8Array() : bytesField(1, message(stringField(1, first)));
}

function serverConfig(): Uint8Array {
  return message(intField(HTTP2_CONFIG_FIELD, HTTP2_FORCE_ALL_DISABLED));
}

/**
 * Pull the user's text out of a `BidiAppend` body. Field 1 is a hex string of
 * a nested message whose field 2 holds the turn, three levels down. The
 * nesting is walked rather than pattern-matched on bytes so a longer prompt,
 * which changes every length prefix, reads the same as a short one.
 */
export function userTextFromBidi(body: Uint8Array): { requestId?: string; text?: string } {
  const top = decode(body);
  const hex = fieldString(top, 1);
  const requestId = (() => {
    const idMsg = fieldBytes(top, 2);
    return idMsg === undefined ? undefined : fieldString(decode(idMsg), 1);
  })();
  if (hex === undefined) {
    return { requestId };
  }
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));
  let level: Field[] = decode(bytes);
  const inner = fieldBytes(level, 1);
  if (inner === undefined) {
    return { requestId };
  }
  level = decode(inner);
  // field 2 -> field 1 -> field 1 -> field 1 is the text; each hop is a
  // single-field wrapper the CLI uses for its message/part structure.
  let cursor = fieldBytes(level, 2);
  for (let depth = 0; depth < 2 && cursor !== undefined; depth += 1) {
    cursor = fieldBytes(decode(cursor), 1);
  }
  if (cursor === undefined) {
    return { requestId };
  }
  return { requestId, text: fieldString(decode(cursor), 1) };
}

function remember(requestId: string | undefined, text: string | undefined): void {
  if (requestId === undefined || text === undefined) {
    return;
  }
  turnFor(requestId).deliver(text);
}

function textDelta(text: string): Uint8Array {
  return bytesField(1, message(bytesField(UPDATE_TEXT_DELTA, message(stringField(1, text)))));
}

function turnEnded(): Uint8Array {
  return bytesField(1, message(bytesField(UPDATE_TURN_ENDED, new Uint8Array())));
}

/**
 * Ask the box's own chat route for the turn, through this door's OpenAI
 * surface rather than the router directly: that is the same path every other
 * consumer takes, so a route's dispatch, warm-up and occupancy all behave
 * here exactly as they do everywhere else.
 */
async function completion(ctx: DoorContext, model: string, prompt: string): Promise<string> {
  const port = ctx.getConfig().listen_port;
  const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `@/llama/${model}`,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    return `engined: chat route ${model} answered ${res.status}`;
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  };
  const choice = body.choices?.[0]?.message;
  return choice?.content || choice?.reasoning_content || "";
}

/** Resolves to `undefined` if no `BidiAppend` names this turn in time. */
function awaitTurn(requestId: string): Promise<string | undefined> {
  const turn = turnFor(requestId);
  return Promise.race([
    turn.text,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), TURN_WAIT_MS)),
  ]);
}

async function runStream(ctx: DoorContext, body: Uint8Array): Promise<Response> {
  const requestId = fieldString(decode(body.subarray(ENVELOPE_HEADER)), 1);
  const prompt = requestId === undefined ? undefined : await awaitTurn(requestId);
  if (requestId !== undefined) {
    TURNS.delete(requestId);
  }
  const models = chatModels(ctx);
  const model = models[0];
  const answer =
    prompt === undefined
      ? "engined: no turn content arrived for this request"
      : model === undefined
        ? "engined: no llama chat route is configured"
        : await completion(ctx, model, prompt);
  const frames = message(envelope(textDelta(answer)), envelope(turnEnded()), endOfStream());
  return new Response(frames as BodyInit, {
    status: 200,
    headers: { "content-type": CONNECT_STREAM_TYPE },
  });
}

export async function handleCursor(
  ctx: DoorContext,
  req: Request,
  pathname: string,
): Promise<Response> {
  const body = new Uint8Array(await req.arrayBuffer());
  const models = chatModels(ctx);
  if (pathname.endsWith("/RunSSE")) {
    return runStream(ctx, body);
  }
  if (pathname.endsWith("/BidiAppend")) {
    const { requestId, text } = userTextFromBidi(body);
    remember(requestId, text);
    return protoResponse(new Uint8Array());
  }
  if (pathname.endsWith("/AvailableModels")) {
    return protoResponse(availableModels(models));
  }
  if (pathname.endsWith("/GetUsableModels")) {
    return protoResponse(modelDetails(models));
  }
  if (pathname.endsWith("ModelForCli")) {
    return protoResponse(defaultModel(models));
  }
  if (pathname.endsWith("/GetServerConfig")) {
    return protoResponse(serverConfig());
  }
  // Everything else in the boot chain -- identity, marketplaces, plugins,
  // telemetry -- is satisfied by an empty message of its own response type.
  return protoResponse(new Uint8Array());
}
