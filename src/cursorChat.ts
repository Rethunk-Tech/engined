/**
 * The bridge from a Cursor turn to this box's own chat route: one streamed
 * completion per round, read back as the text, reasoning, tool calls and
 * usage the turn needs.
 */

import { routeAddress } from './control.ts'
import type { ChatMessage, ChatReply, StreamSink } from './cursorAgent.ts'
import { chatModels } from './cursorDoor.ts'
import { TOOL_SCHEMA } from './cursorExec.ts'
import type { DoorContext } from './doorContext.ts'
import { CONTENT_TYPE, JSON_CONTENT_TYPE, splitSseFrames, sseDataPayloads } from './http.ts'
import { CONTENT_ENDPOINT_CHAT, parseRecord } from './types.ts'

interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: ToolCallDelta[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/**
 * Ask the local route for the next step. Streaming is what lets the CLI show
 * an answer as it is written rather than after a local model has thought for
 * a minute, and it is the only way reasoning reaches the thinking frames at
 * all -- a buffered reply has already lost the ordering.
 */
export async function completeLocally(
  ctx: DoorContext,
  messages: ChatMessage[],
  on: StreamSink,
): Promise<ChatReply> {
  const route = chatModels(ctx)[0]
  if (route === undefined) {
    return { text: 'engined: no llama chat route is configured', toolCalls: [] }
  }
  const cfg = ctx.getConfig()
  const address = routeAddress(route, cfg.routes)
  const res = await fetch(`http://127.0.0.1:${cfg.listen_port}${CONTENT_ENDPOINT_CHAT}`, {
    method: 'POST',
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify({
      model: address,
      messages,
      tools: TOOL_SCHEMA,
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  if (!res.ok || res.body === null) {
    return { text: `engined: chat route ${address} answered ${res.status}`, toolCalls: [] }
  }
  return await readChatStream(res.body, on)
}

/** One SSE data payload's JSON chunk, or `undefined` for anything that is not JSON. */
function parseDataPayload(payload: string): ChatChunk | undefined {
  const parsed = parseRecord(payload)
  if (parsed === null) {
    return
  }
  return parsed as ChatChunk
}

interface ToolCallSlot {
  id: string
  name: string
  args: string
}

function applyChatChunk(
  chunk: ChatChunk,
  calls: ToolCallSlot[],
  on: StreamSink,
  acc: { text: string; usage: ChatReply['usage'] },
): void {
  const delta = chunk.choices?.[0]?.delta
  if (delta?.reasoning_content) {
    on.thinking(delta.reasoning_content)
  }
  if (delta?.content) {
    acc.text += delta.content
    on.text(delta.content)
  }
  stitchToolCalls(calls, delta?.tool_calls ?? [], on)
  if (chunk.usage) {
    acc.usage = {
      input: chunk.usage.prompt_tokens ?? 0,
      output: chunk.usage.completion_tokens ?? 0,
      cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
    }
  }
}

function stitchToolCalls(calls: ToolCallSlot[], parts: ToolCallDelta[], on: StreamSink): void {
  for (const part of parts) {
    const at = part.index ?? 0
    calls[at] ??= { id: '', name: '', args: '' }
    const slot = calls[at]
    slot.id = part.id ?? slot.id
    slot.name = part.function?.name ?? slot.name
    const argsDelta = part.function?.arguments ?? ''
    slot.args += argsDelta
    // The id can arrive after the first argument fragment, so the partial
    // frames key off whatever identifies the call at that moment.
    on.toolArgs(slot.id || `call_${at}`, argsDelta)
  }
}

/**
 * Read an OpenAI-shaped SSE completion. Tool calls arrive as indexed deltas
 * that have to be stitched back together before they mean anything, and the
 * usage block only appears on the final chunk.
 */
async function readChatStream(
  body: ReadableStream<Uint8Array>,
  on: StreamSink,
): Promise<ChatReply> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const calls: ToolCallSlot[] = []
  const acc: { text: string; usage: ChatReply['usage'] } = { text: '', usage: undefined }
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const { frames, carry } = splitSseFrames(buffer)
    buffer = carry
    for (const frame of frames) {
      for (const payload of sseDataPayloads(frame)) {
        const chunk = parseDataPayload(payload)
        if (chunk !== undefined) {
          applyChatChunk(chunk, calls, on, acc)
        }
      }
    }
  }
  return {
    text: acc.text,
    toolCalls: calls
      .filter((c) => c.name.length > 0)
      .map((c, i) => ({
        id: c.id || `call_${i}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args },
      })),
    usage: acc.usage,
  }
}
