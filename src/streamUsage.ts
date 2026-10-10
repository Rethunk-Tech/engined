/**
 * Cost stated by a streamed reply. The provenance line is deferred until the
 * stream ends, so the figure is there to be read by the time the line is written.
 *
 * Scans rather than buffers: SSE frames are newline-delimited, so this keeps
 * one partial line and forgets every frame it has already considered. The
 * `"usage"` substring guard is what keeps it off the hot path -- a token
 * delta never matches it, so no chunk of ordinary output is ever parsed.
 *
 * The LAST usage seen wins. An upstream that reports cumulatively per frame
 * ends on the total; one that reports once ends on the only one.
 *
 * Against llama-server, a streamed reply carries NO `usage` frame unless the
 * caller sent `stream_options: {include_usage: true}`. It always carries
 * `timings`, whose `prompt_n`/`predicted_n` are token counts -- deliberately
 * not read here. With a prefix-cache hit `prompt_n` is only the uncached
 * remainder, so a figure from it would be engined's own arithmetic rather
 * than the engine's answer, and llama is the local engine, which no budget
 * is counting anyway. The paid upstreams all speak `usage` or nothing.
 */

import { usageOrUndefined } from './agents.ts'
import { splitSseFrames, sseDataPayloads } from './http.ts'
import type { Usage } from './provenance.ts'
import { finiteNumber, isRecord, parseRecord } from './records.ts'

/** One reported `usage` object as engined records it, or `undefined` for one it understood no field of -- which is not a cost record. */
export function pickUsage(raw: Record<string, unknown>): Usage | undefined {
  return usageOrUndefined({
    prompt_tokens: finiteNumber(raw.prompt_tokens),
    completion_tokens: finiteNumber(raw.completion_tokens),
    total_tokens: finiteNumber(raw.total_tokens),
    // The upstream's own dollar figure, when it sent one (`cost` is the
    // OpenRouter spelling, `cost_usd` anyone who already speaks ours). Never
    // a token count multiplied by a rate this repo does not have.
    cost_usd: finiteNumber(raw.cost_usd) ?? finiteNumber(raw.cost),
  })
}

export class StreamUsage {
  private readonly decoder = new TextDecoder()
  private carry = ''
  private found: Usage | undefined

  push(chunk: Uint8Array): void {
    this.carry += this.decoder.decode(chunk, { stream: true })
    const { frames, carry } = splitSseFrames(this.carry)
    this.carry = carry
    for (const frame of frames) {
      for (const payload of sseDataPayloads(frame)) {
        this.consider(payload)
      }
    }
  }

  /** The figure to record, after the last frame. The final line needs considering too: a stream may end without a trailing newline. */
  done(): Usage | undefined {
    for (const payload of sseDataPayloads(this.carry)) {
      this.consider(payload)
    }
    // A remote JSON reply is handed to the caller as the original byte
    // stream, so it never passes through a buffered body. With no SSE
    // framing the whole object is still sitting in `carry`.
    if (this.found === undefined) {
      const usage = parseRecord(this.carry)?.usage
      if (isRecord(usage)) {
        this.found = pickUsage(usage)
      }
    }
    return this.found
  }

  private consider(payload: string): void {
    if (!payload.includes('"usage"')) {
      return
    }
    const usage = parseRecord(payload)?.usage
    if (isRecord(usage)) {
      this.found = pickUsage(usage) ?? this.found
    }
  }
}
