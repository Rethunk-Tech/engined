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

import http2, { type ServerHttp2Stream } from 'node:http2'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { execOutcome, execRequest, type ToolRequest, toolCallMessage } from './cursorExec.ts'
import {
  bytesField,
  decode,
  ENVELOPE_HEADER,
  endOfStream,
  envelope,
  fieldBytes,
  fieldString,
  intField,
  message,
  stringField,
} from './cursorProto.ts'
import { STATUS_NOT_FOUND, STATUS_OK } from './http.ts'
import { errMessage, parseRecord } from './records.ts'

const RUN_PATH = '/agent.v1.AgentService/Run'
const CONNECT_STREAM_TYPE = 'application/connect+proto'
const EXEC_CLIENT_FIELD = 2
const INTERACTION_UPDATE = 1
const TEXT_DELTA = 1
const TURN_ENDED = 14
const HEARTBEAT = 13
const THINKING_DELTA = 4
const THINKING_COMPLETED = 5
const TOOL_CALL_STARTED = 2
const TOOL_CALL_COMPLETED = 3
const PARTIAL_TOOL_CALL = 7
const MESSAGE_STARTED_AT_MS = 25

/**
 * A local model can think for minutes on a long brief, and the client drops a
 * stream that goes quiet. Heartbeats hold it open without pretending to be
 * output.
 */
const HEARTBEAT_MS = 5000

/**
 * One Connect frame per token delta floods the stream -- a 50k-token answer
 * is 50k frames -- and HTTP/2 flow control eventually drops the session.
 * Deltas are coalesced into this window instead, which the CLI renders the
 * same way at a fraction of the frames.
 */
const COALESCE_MS = 60

/**
 * Stop a runaway model without cutting off real work: a multi-file build
 * legitimately runs dozens of rounds, and a turn that hits this ceiling
 * silently abandons whatever it had not yet committed.
 */
const MAX_TOOL_ROUNDS = 150

/** Rounds left when the model is told to wrap up, so it can still commit. */
const WRAP_UP_MARGIN = 8

/** Consecutive completion failures before the turn gives up. */
const MAX_COMPLETION_FAILURES = 2

/**
 * Tool output goes into the history verbatim, so one `cat` of a large file
 * can push the next request past the route's context and the engine answers
 * 500 with nothing naming the cause. Truncating the middle keeps the head and
 * tail a model actually reasons over.
 */
const MAX_TOOL_CHARS = 8000

function clamp(text: string): string {
  if (text.length <= MAX_TOOL_CHARS) {
    return text
  }
  const half = Math.floor(MAX_TOOL_CHARS / 2)
  const dropped = text.length - MAX_TOOL_CHARS
  return `${text.slice(0, half)}\n... [${dropped} characters elided] ...\n${text.slice(-half)}`
}

export interface AgentDeps {
  /**
   * Ask the local chat route for the next step, tools included. Text and
   * reasoning arrive through the callbacks as the model produces them; the
   * resolved reply carries the tool calls and the usage.
   */
  complete: (messages: ChatMessage[], on: StreamSink) => Promise<ChatReply>
}

export interface StreamSink {
  text: (chunk: string) => void
  thinking: (chunk: string) => void
  toolArgs: (callId: string, chunk: string) => void
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCallOut[]
}

interface ToolCallOut {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatReply {
  text: string
  toolCalls: ToolCallOut[]
  usage?: TurnUsage
}

/**
 * What the CLI reports as the turn's cost. It reads these off
 * `TurnEndedUpdate` and nowhere else -- an empty turn_ended is why a local
 * run shows no tokens at all.
 */
interface TurnUsage {
  input: number
  output: number
  cacheRead: number
}

/**
 * Wrap one `InteractionUpdate`. The client's own constructors always set
 * `messageStartedAtMs`, so ours do too -- a frame without it is a frame the
 * CLI cannot place on its timeline.
 */
function update(field: number, payload: Uint8Array): Uint8Array {
  return bytesField(
    INTERACTION_UPDATE,
    message(bytesField(field, payload), intField(MESSAGE_STARTED_AT_MS, Date.now())),
  )
}

function textDelta(text: string): Uint8Array {
  return update(TEXT_DELTA, message(stringField(1, text)))
}

function thinkingDelta(text: string): Uint8Array {
  return update(THINKING_DELTA, message(stringField(1, text)))
}

function thinkingCompleted(ms: number): Uint8Array {
  return update(THINKING_COMPLETED, message(intField(1, ms)))
}

/** `ToolCallStartedUpdate`/`ToolCallCompletedUpdate{1 call_id, 2 tool_call, 3 model_call_id}`. */
function toolCallFrame(field: number, callId: string, call: Uint8Array): Uint8Array {
  return update(field, message(stringField(1, callId), bytesField(2, call), stringField(3, callId)))
}

/**
 * `PartialToolCallUpdate{1 call_id, 2 tool_call, 3 args_text_delta, 4 model_call_id}`:
 * the arguments as the model writes them, so a tool call renders while it is
 * still being composed instead of appearing whole at the end.
 */
function partialToolCall(callId: string, argsDelta: string): Uint8Array {
  return update(
    PARTIAL_TOOL_CALL,
    message(stringField(1, callId), stringField(3, argsDelta), stringField(4, callId)),
  )
}

function heartbeat(): Uint8Array {
  return update(HEARTBEAT, new Uint8Array())
}

function turnEnded(usage: TurnUsage): Uint8Array {
  return bytesField(
    INTERACTION_UPDATE,
    message(
      bytesField(
        TURN_ENDED,
        message(intField(1, usage.input), intField(2, usage.output), intField(3, usage.cacheRead)),
      ),
    ),
  )
}

/**
 * The user's turn, three single-field wrappers deep inside the client's
 * conversation-action message. Walked rather than matched on bytes so a long
 * prompt, which changes every length prefix, reads the same as a short one.
 */
function userText(frame: Uint8Array): string | undefined {
  const action = fieldBytes(decode(frame), 1)
  if (action === undefined) {
    return undefined
  }
  let cursor = fieldBytes(decode(action), 2)
  for (let depth = 0; depth < 2 && cursor !== undefined; depth += 1) {
    cursor = fieldBytes(decode(cursor), 1)
  }
  return cursor === undefined ? undefined : fieldString(decode(cursor), 1)
}

export function toolRequestFrom(call: ToolCallOut): ToolRequest {
  const args = parseRecord(call.function.arguments) ?? {}
  const str = (key: string): string | undefined =>
    typeof args[key] === 'string' ? (args[key] as string) : undefined
  const num = (key: string): number | undefined =>
    typeof args[key] === 'number' ? (args[key] as number) : undefined
  const list = (key: string): string[] | undefined =>
    Array.isArray(args[key])
      ? (args[key] as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined
  return {
    tool: call.function.name as ToolRequest['tool'],
    command: str('command'),
    path: str('path'),
    content: str('content'),
    pattern: str('pattern'),
    glob: str('glob'),
    outputMode: str('output_mode'),
    context: num('context'),
    contextBefore: num('context_before'),
    contextAfter: num('context_after'),
    caseInsensitive: args.case_insensitive === true,
    fileType: str('type'),
    headLimit: num('head_limit'),
    multiline: args.multiline === true,
    sort: str('sort'),
    sortAscending: args.sort_ascending === true,
    resultOffset: num('offset'),
    background: args.background === true,
    offset: num('offset'),
    limit: num('limit'),
    ignore: list('ignore'),
    description: str('description'),
  }
}

/**
 * Connect sets the low bit of a frame's flag byte when the payload is
 * compressed, and the client only compresses once a turn is big enough --
 * which is why short prompts work against a decoder that ignores it and a
 * real brief does not.
 */
const FLAG_COMPRESSED = 1

/** Split a stream's bytes into Connect envelopes as they arrive. */
function framer(onFrame: (payload: Uint8Array) => void): (chunk: Uint8Array) => void {
  let buffer = new Uint8Array()
  return (chunk: Uint8Array) => {
    const next = new Uint8Array(buffer.length + chunk.length)
    next.set(buffer)
    next.set(chunk, buffer.length)
    buffer = next
    for (;;) {
      if (buffer.length < ENVELOPE_HEADER) {
        return
      }
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1, false)
      if (buffer.length < ENVELOPE_HEADER + length) {
        return
      }
      const flags = buffer[0] ?? 0
      const payload = buffer.subarray(ENVELOPE_HEADER, ENVELOPE_HEADER + length)
      buffer = buffer.subarray(ENVELOPE_HEADER + length)
      onFrame(flags % 2 === FLAG_COMPRESSED ? new Uint8Array(gunzipSync(payload)) : payload)
    }
  }
}

/**
 * One turn. The model speaks, and whenever it calls a tool the request goes
 * to the CLI and the answer comes back on the same stream before the model is
 * asked again.
 */
interface Turn {
  deps: AgentDeps
  send: (frame: Uint8Array) => void
  awaitExec: () => Promise<Uint8Array>
  total: TurnUsage
}

/**
 * Collect deltas and emit them on a short timer, so a long answer costs tens
 * of frames rather than tens of thousands.
 */
function coalescer(emit: (text: string) => void): {
  push: (chunk: string) => void
  flush: () => void
} {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending.length > 0) {
      const out = pending
      pending = ''
      emit(out)
    }
  }
  return {
    push: (chunk: string) => {
      pending += chunk
      timer ??= setTimeout(flush, COALESCE_MS)
    },
    flush,
  }
}

/** Execute one round's tool calls through the CLI, in order, and record each outcome in the history. */
async function runToolCalls(
  turn: Turn,
  round: number,
  calls: ChatReply['toolCalls'],
  history: ChatMessage[],
): Promise<void> {
  const { send, awaitExec } = turn
  for (const call of calls) {
    const request = execRequest(round + 1, call.id, toolRequestFrom(call))
    if (request === undefined) {
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: `unknown tool ${call.function.name}`,
      })
      continue
    }
    // The CLI renders from ToolCall frames and executes from the exec
    // message; sending only the latter runs the tool invisibly.
    const req = toolRequestFrom(call)
    const rendered = toolCallMessage(req, call.id)
    if (rendered !== undefined) {
      send(envelope(toolCallFrame(TOOL_CALL_STARTED, call.id, rendered)))
    }
    send(envelope(request))
    const outcome = execOutcome(await awaitExec())
    if (rendered !== undefined) {
      send(envelope(toolCallFrame(TOOL_CALL_COMPLETED, call.id, rendered)))
    }
    history.push({ role: 'tool', tool_call_id: call.id, content: clamp(outcome.text) })
  }
}

async function runTurn(turn: Turn, prompt: string): Promise<void> {
  const { deps, send, total } = turn
  const history: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are working in a real repository through tools. Use them to inspect and change files. Answer briefly when finished.',
    },
    { role: 'user', content: prompt },
  ]
  let failures = 0
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const left = MAX_TOOL_ROUNDS - round
    if (left === WRAP_UP_MARGIN) {
      history.push({
        role: 'user',
        content: `You have ${WRAP_UP_MARGIN} tool calls left in this turn. Finish what you are doing, commit your work, and give your final answer now.`,
      })
    }
    const beat = setInterval(() => send(envelope(heartbeat())), HEARTBEAT_MS)
    const startedAt = Date.now()
    let thought = false
    let streamed = false
    const textOut = coalescer((chunk) => send(envelope(textDelta(chunk))))
    const thinkOut = coalescer((chunk) => send(envelope(thinkingDelta(chunk))))
    let reply: ChatReply
    try {
      reply = await deps.complete(history, {
        text: (chunk) => {
          if (chunk.length === 0) {
            return
          }
          if (thought) {
            thinkOut.flush()
            send(envelope(thinkingCompleted(Date.now() - startedAt)))
            thought = false
          }
          streamed = true
          textOut.push(chunk)
        },
        thinking: (chunk) => {
          if (chunk.length === 0) {
            return
          }
          thought = true
          thinkOut.push(chunk)
        },
        toolArgs: (callId, chunk) => {
          if (chunk.length > 0) {
            send(envelope(partialToolCall(callId, chunk)))
          }
        },
      })
    } catch (err) {
      // One bad completion -- a timeout, a dropped engine -- should cost a
      // round, not the turn's uncommitted work.
      clearInterval(beat)
      const detail = errMessage(err)
      if (failures >= MAX_COMPLETION_FAILURES) {
        send(envelope(textDelta(`engined: chat route failed repeatedly (${detail})`)))
        return
      }
      failures += 1
      history.push({
        role: 'user',
        content: `The previous request failed (${detail}). Retry the step, or finish and commit what you already have.`,
      })
      continue
    } finally {
      clearInterval(beat)
      textOut.flush()
      thinkOut.flush()
    }
    if (thought) {
      send(envelope(thinkingCompleted(Date.now() - startedAt)))
    }
    if (reply.usage !== undefined) {
      total.input += reply.usage.input
      total.output += reply.usage.output
      total.cacheRead += reply.usage.cacheRead
    }
    // Only fall back to the whole answer when nothing streamed; otherwise
    // the turn would print twice.
    if (!streamed && reply.text.length > 0) {
      send(envelope(textDelta(reply.text)))
    }
    if (reply.toolCalls.length === 0) {
      return
    }
    history.push({ role: 'assistant', content: reply.text, tool_calls: reply.toolCalls })
    await runToolCalls(turn, round, reply.toolCalls, history)
  }
  // Reaching the ceiling is a real outcome; saying nothing leaves the CLI
  // showing a turn that simply stopped.
  send(envelope(textDelta('engined: tool-call budget for this turn is exhausted.')))
}

export interface CursorAgentServer {
  stop: () => void
  port: number
}

/**
 * Serve the Run stream. The caller's `complete` owns how the route is dialled
 * and which tools it offers, so this module never has to know either.
 */
export function serveCursorAgent(port: number, deps: AgentDeps): CursorAgentServer {
  const server = http2.createServer()
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    if (headers[':path'] !== RUN_PATH) {
      stream.respond({ ':status': STATUS_NOT_FOUND })
      stream.end()
      return
    }
    stream.respond({ ':status': STATUS_OK, 'content-type': CONNECT_STREAM_TYPE })

    let started = false
    let deliverExec: ((payload: Uint8Array) => void) | undefined
    const awaitExec = () =>
      new Promise<Uint8Array>((resolve) => {
        deliverExec = resolve
      })

    const onFrame = (payload: Uint8Array) => {
      const execClient = fieldBytes(decode(payload), EXEC_CLIENT_FIELD)
      if (execClient !== undefined && deliverExec !== undefined) {
        const deliver = deliverExec
        deliverExec = undefined
        deliver(execClient)
        return
      }
      if (started) {
        return
      }
      const prompt = userText(payload)
      if (prompt === undefined) {
        return
      }
      started = true
      const total: TurnUsage = { input: 0, output: 0, cacheRead: 0 }
      runTurn({ deps, send: (frame) => stream.write(Buffer.from(frame)), awaitExec, total }, prompt)
        .catch((err: unknown) => {
          const detail = errMessage(err)
          stream.write(Buffer.from(envelope(textDelta(`engined: ${detail}`))))
        })
        .finally(() => {
          stream.write(Buffer.from(envelope(turnEnded(total))))
          stream.end(Buffer.from(endOfStream()))
        })
    }

    stream.on('data', framer(onFrame))
    // Swallowing this hides the one event that explains a dead turn.
    stream.on('error', (err: Error) => {
      process.stderr.write(`cursor stream error: ${err.message}\n`)
    })
  })
  server.listen(port, '127.0.0.1')
  return { stop: () => server.close(), port }
}
