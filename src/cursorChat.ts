/**
 * The bridge from a Cursor turn to this box's own chat route: one streamed
 * completion per round, read back as the text, reasoning, tool calls and
 * usage the turn needs.
 */

import type { ChatMessage, ChatReply, StreamSink } from './cursorAgent.ts'
import { chatModels } from './cursorDoor.ts'
import { TOOL_SCHEMA } from './cursorExec.ts'
import type { DoorContext } from './doorContext.ts'

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
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
  const model = chatModels(ctx)[0]
  if (model === undefined) {
    return { text: 'engined: no llama chat route is configured', toolCalls: [] }
  }
  const res = await fetch(
    `http://127.0.0.1:${ctx.getConfig().listen_port}/openai/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `@/llama/${model}`,
        messages,
        tools: TOOL_SCHEMA,
        stream: true,
        stream_options: { include_usage: true },
      }),
    },
  )
  if (!res.ok || res.body === null) {
    return { text: `engined: chat route ${model} answered ${res.status}`, toolCalls: [] }
  }
  return await readChatStream(res.body, on)
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
  const calls: { id: string; name: string; args: string }[] = []
  let text = ''
  let usage: ChatReply['usage']
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue
      }
      const payload = line.slice(5).trim()
      if (payload.length === 0 || payload === '[DONE]') {
        continue
      }
      let chunk: ChatChunk
      try {
        chunk = JSON.parse(payload) as ChatChunk
      } catch {
        continue
      }
      const delta = chunk.choices?.[0]?.delta
      if (delta?.reasoning_content) {
        on.thinking(delta.reasoning_content)
      }
      if (delta?.content) {
        text += delta.content
        on.text(delta.content)
      }
      for (const part of delta?.tool_calls ?? []) {
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
      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        }
      }
    }
  }
  return {
    text,
    toolCalls: calls
      .filter((c) => c.name.length > 0)
      .map((c, i) => ({
        id: c.id || `call_${i}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args },
      })),
    usage,
  }
}
