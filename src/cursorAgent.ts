/**
 * The `agent.v1.AgentService/Run` stream: one open h2 stream per turn, the
 * model on one side and cursor-agent's own tool executor on the other.
 *
 * This is a second listener rather than a route on the main door because the
 * RPC is bidirectional and needs HTTP/2, which the cleartext door does not
 * speak. It serves h2c with prior knowledge -- no ALPN, because a TLS
 * terminator in front is what negotiates protocols for real callers, and a
 * cleartext server that tried to serve both HTTP/1.1 and h2 on one port could
 * not tell them apart.
 */

import http2, { type ServerHttp2Stream } from "node:http2";
import { gunzipSync } from "node:zlib";
import { execOutcome, execRequest, type ToolRequest } from "./cursorExec.ts";
import {
  bytesField,
  decode,
  ENVELOPE_HEADER,
  endOfStream,
  envelope,
  fieldBytes,
  fieldString,
  message,
  stringField,
} from "./cursorProto.ts";

const RUN_PATH = "/agent.v1.AgentService/Run";
const CONNECT_STREAM_TYPE = "application/connect+proto";
const EXEC_CLIENT_FIELD = 2;
const INTERACTION_UPDATE = 1;
const TEXT_DELTA = 1;
const TURN_ENDED = 14;
const HEARTBEAT = 13;

/**
 * A local model can think for minutes on a long brief, and the client drops a
 * stream that goes quiet. Heartbeats hold it open without pretending to be
 * output.
 */
const HEARTBEAT_MS = 5000;

/** Stop a runaway model rather than letting one turn loop forever. */
const MAX_TOOL_ROUNDS = 40;

export interface AgentDeps {
  /** Ask the local chat route for the next step, tools included. */
  complete: (messages: ChatMessage[]) => Promise<ChatReply>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallOut[];
}

export interface ToolCallOut {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatReply {
  text: string;
  toolCalls: ToolCallOut[];
}

function textDelta(text: string): Uint8Array {
  return bytesField(
    INTERACTION_UPDATE,
    message(bytesField(TEXT_DELTA, message(stringField(1, text)))),
  );
}

function heartbeat(): Uint8Array {
  return bytesField(INTERACTION_UPDATE, message(bytesField(HEARTBEAT, new Uint8Array())));
}

function turnEnded(): Uint8Array {
  return bytesField(INTERACTION_UPDATE, message(bytesField(TURN_ENDED, new Uint8Array())));
}

/**
 * The user's turn, three single-field wrappers deep inside the client's
 * conversation-action message. Walked rather than matched on bytes so a long
 * prompt, which changes every length prefix, reads the same as a short one.
 */
export function userText(frame: Uint8Array): string | undefined {
  const action = fieldBytes(decode(frame), 1);
  if (action === undefined) {
    return undefined;
  }
  let cursor = fieldBytes(decode(action), 2);
  for (let depth = 0; depth < 2 && cursor !== undefined; depth += 1) {
    cursor = fieldBytes(decode(cursor), 1);
  }
  return cursor === undefined ? undefined : fieldString(decode(cursor), 1);
}

function toolRequestFrom(call: ToolCallOut): ToolRequest {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    args = {};
  }
  const str = (key: string): string | undefined =>
    typeof args[key] === "string" ? (args[key] as string) : undefined;
  return {
    tool: call.function.name as ToolRequest["tool"],
    command: str("command"),
    path: str("path"),
    content: str("content"),
    pattern: str("pattern"),
  };
}

/**
 * Connect sets the low bit of a frame's flag byte when the payload is
 * compressed, and the client only compresses once a turn is big enough --
 * which is why short prompts work against a decoder that ignores it and a
 * real brief does not.
 */
const FLAG_COMPRESSED = 1;

/** Split a stream's bytes into Connect envelopes as they arrive. */
function framer(onFrame: (payload: Uint8Array) => void): (chunk: Uint8Array) => void {
  let buffer = new Uint8Array();
  return (chunk: Uint8Array) => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
    for (;;) {
      if (buffer.length < ENVELOPE_HEADER) {
        return;
      }
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1, false);
      if (buffer.length < ENVELOPE_HEADER + length) {
        return;
      }
      const flags = buffer[0] ?? 0;
      const payload = buffer.subarray(ENVELOPE_HEADER, ENVELOPE_HEADER + length);
      buffer = buffer.subarray(ENVELOPE_HEADER + length);
      onFrame(flags % 2 === FLAG_COMPRESSED ? new Uint8Array(gunzipSync(payload)) : payload);
    }
  };
}

/**
 * One turn. The model speaks, and whenever it calls a tool the request goes
 * to the CLI and the answer comes back on the same stream before the model is
 * asked again.
 */
async function runTurn(
  deps: AgentDeps,
  prompt: string,
  send: (frame: Uint8Array) => void,
  awaitExec: () => Promise<Uint8Array>,
): Promise<void> {
  const history: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are working in a real repository through tools. Use them to inspect and change files. Answer briefly when finished.",
    },
    { role: "user", content: prompt },
  ];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const beat = setInterval(() => send(envelope(heartbeat())), HEARTBEAT_MS);
    let reply: ChatReply;
    try {
      reply = await deps.complete(history);
    } finally {
      clearInterval(beat);
    }
    if (reply.text.length > 0) {
      send(envelope(textDelta(reply.text)));
    }
    if (reply.toolCalls.length === 0) {
      return;
    }
    history.push({ role: "assistant", content: reply.text, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const request = execRequest(round + 1, call.id, toolRequestFrom(call));
      if (request === undefined) {
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: `unknown tool ${call.function.name}`,
        });
        continue;
      }
      send(envelope(request));
      const outcome = execOutcome(await awaitExec());
      history.push({ role: "tool", tool_call_id: call.id, content: outcome.text });
    }
  }
}

export interface CursorAgentServer {
  stop: () => void;
  port: number;
}

/**
 * Serve the Run stream. The caller's `complete` owns how the route is dialled
 * and which tools it offers, so this module never has to know either.
 */
export function serveCursorAgent(port: number, deps: AgentDeps): CursorAgentServer {
  const server = http2.createServer();
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    if (headers[":path"] !== RUN_PATH) {
      stream.respond({ ":status": 404 });
      stream.end();
      return;
    }
    stream.respond({ ":status": 200, "content-type": CONNECT_STREAM_TYPE });

    let started = false;
    let deliverExec: ((payload: Uint8Array) => void) | undefined;
    const awaitExec = () =>
      new Promise<Uint8Array>((resolve) => {
        deliverExec = resolve;
      });

    const onFrame = (payload: Uint8Array) => {
      const execClient = fieldBytes(decode(payload), EXEC_CLIENT_FIELD);
      if (execClient !== undefined && deliverExec !== undefined) {
        const deliver = deliverExec;
        deliverExec = undefined;
        deliver(execClient);
        return;
      }
      if (started) {
        return;
      }
      const prompt = userText(payload);
      if (prompt === undefined) {
        return;
      }
      started = true;
      runTurn(deps, prompt, (frame) => stream.write(Buffer.from(frame)), awaitExec)
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          stream.write(Buffer.from(envelope(textDelta(`engined: ${detail}`))));
        })
        .finally(() => {
          stream.write(Buffer.from(envelope(turnEnded())));
          stream.end(Buffer.from(endOfStream()));
        });
    };

    stream.on("data", framer(onFrame));
    stream.on("error", () => undefined);
  });
  server.listen(port, "127.0.0.1");
  return { stop: () => server.close(), port };
}
