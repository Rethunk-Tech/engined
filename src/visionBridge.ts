/**
 * The opt-in door-side bridge that lets an image reach a text-only chat route.
 * `vision_bridge` on a route (`types.ts`) names a `role = "vision"` address;
 * when the caller's request carries OpenAI image content parts, each image is
 * sent to that address as its own chat request, captioned, and spliced back
 * into the original request as `[Image N: <caption>]` text -- in image order,
 * one image per bridge request -- before the rewritten body ever reaches the
 * route the caller actually addressed.
 *
 * Dispatches through `buildHopExec` exactly as a chat hop does, so the bridge
 * call shares the same lease/abort plumbing: a caller abort cancels it too.
 */

import { classifyResult, type HopResult, parseHop } from './chain.ts'
import type { DoorContext } from './doorContext.ts'
import { buildHopExec } from './hop.ts'
import { jsonError, STATUS_BAD_GATEWAY } from './http.ts'
import type { Attempt } from './provenance.ts'
import { CONTENT_ENDPOINT_CHAT, errMessage, isRecord, MS_PER_SECOND } from './types.ts'

/**
 * Fixed rather than configurable: the bridge exists to feed a text-only route
 * a caption, and a caller-supplied instruction here would be a second, wholly
 * unvalidated prompt path into a model this request never named.
 */
const BRIDGE_SYSTEM_PROMPT =
  'Transcribe any text visible in the image verbatim, then describe the image concisely.'

const BRIDGE_MAX_TOKENS = 512
const BRIDGE_TEMPERATURE = 0.2

interface ImageUrlPart {
  type: 'image_url'
  image_url: { url: string }
}

function isImageUrlPart(value: unknown): value is ImageUrlPart {
  return (
    isRecord(value) &&
    value.type === 'image_url' &&
    isRecord(value.image_url) &&
    typeof value.image_url.url === 'string' &&
    (value.image_url.url.startsWith('data:') ||
      value.image_url.url.startsWith('http://') ||
      value.image_url.url.startsWith('https://'))
  )
}

/** Whether any message carries at least one image content part this bridge can act on. Cheap enough to run on every chat request; a text-only body never even reaches an array `content` field. */
export function bodyHasBridgeableImages(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.some(
    (m) => isRecord(m) && Array.isArray(m.content) && m.content.some(isImageUrlPart),
  )
}

function usageFromParsed(parsed: unknown): Attempt['usage'] {
  if (!(isRecord(parsed) && isRecord(parsed.usage))) {
    return undefined
  }
  const { prompt_tokens, completion_tokens, total_tokens } = parsed.usage
  const usage: Attempt['usage'] = {
    prompt_tokens: typeof prompt_tokens === 'number' ? prompt_tokens : undefined,
    completion_tokens: typeof completion_tokens === 'number' ? completion_tokens : undefined,
    total_tokens: typeof total_tokens === 'number' ? total_tokens : undefined,
  }
  return Object.values(usage).some((v) => v !== undefined) ? usage : undefined
}

function extractCaption(parsed: unknown): string | undefined {
  if (!(isRecord(parsed) && Array.isArray(parsed.choices))) {
    return undefined
  }
  const [first] = parsed.choices
  if (!(isRecord(first) && isRecord(first.message))) {
    return undefined
  }
  const { content } = first.message
  return typeof content === 'string' && content.trim() !== '' ? content.trim() : undefined
}

/** The bridge hop's own reply, whatever its status -- both a caption and an error body are small JSON, so this always buffers rather than forwarding a stream nobody but this function reads. */
async function readHopJson(result: HopResult): Promise<unknown> {
  if (result.stream) {
    const text = await new Response(result.stream).text()
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  return result.body
}

interface CaptionOutcome {
  ok: boolean
  caption?: string
  attempt: Attempt
}

/** One image, one chat request against the bridge address, one attempt -- never the caption text itself (INVARIANT: no door logs prompt content; a caption is content too). */
async function captionOneImage(
  ctx: DoorContext,
  opts: { bridgeAddress: string; url: string; signal: AbortSignal; launchScoped: boolean },
): Promise<CaptionOutcome> {
  const { engine, model } = parseHop(opts.bridgeAddress)
  const start = Date.now()
  const controller = new AbortController()
  const timeoutMs = ctx.getConfig().chat_timeout_seconds * MS_PER_SECOND
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = AbortSignal.any([controller.signal, opts.signal])
  const exec = buildHopExec(
    ctx,
    {
      pathname: CONTENT_ENDPOINT_CHAT,
      rawBody: {
        messages: [
          { role: 'system', content: BRIDGE_SYSTEM_PROMPT },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: opts.url } }] },
        ],
        temperature: BRIDGE_TEMPERATURE,
        max_tokens: BRIDGE_MAX_TOKENS,
        stream: false,
      },
      setContentType: () => undefined,
      toolsHonourableElsewhere: false,
      inChain: false,
    },
    opts.launchScoped,
  )
  try {
    const result = await exec(opts.bridgeAddress, signal)
    clearTimeout(timer)
    const durationMs = Date.now() - start
    const ok = result.status >= 200 && result.status < 300
    const parsed = await readHopJson(result)
    if (!ok) {
      return {
        ok: false,
        attempt: {
          engine,
          model,
          ok: false,
          failure: classifyResult({ ...result, body: parsed ?? result.body }).failure,
          duration_ms: durationMs,
          upstream_used: result.upstreamUsed,
        },
      }
    }
    const caption = extractCaption(parsed)
    if (caption === undefined) {
      return {
        ok: false,
        attempt: {
          engine,
          model,
          ok: false,
          failure: 'bridge reply carried no caption text',
          duration_ms: durationMs,
          upstream_used: result.upstreamUsed,
        },
      }
    }
    return {
      ok: true,
      caption,
      attempt: {
        engine,
        model,
        ok: true,
        duration_ms: durationMs,
        upstream_used: result.upstreamUsed,
        usage: usageFromParsed(parsed),
      },
    }
  } catch (err) {
    clearTimeout(timer)
    const durationMs = Date.now() - start
    const failure = opts.signal.aborted
      ? 'client disconnected'
      : controller.signal.aborted
        ? 'timeout'
        : `connection failed: ${errMessage(err)}`
    return { ok: false, attempt: { engine, model, ok: false, failure, duration_ms: durationMs } }
  }
}

export type BridgeResult =
  | { ok: true; body: Record<string, unknown>; attempts: Attempt[] }
  | { ok: false; response: Response; attempts: Attempt[] }

/**
 * Every image content part, in message order, replaced by its caption --
 * text parts and every other message field pass through untouched. Stops at
 * the first bridge failure: the door refuses the whole request naming the
 * bridge and the image index, rather than silently dropping the image or
 * dispatching a request the caller never sent.
 */
export async function bridgeImages(
  ctx: DoorContext,
  opts: {
    bridgeAddress: string
    body: Record<string, unknown>
    signal: AbortSignal
    launchScoped: boolean
  },
): Promise<BridgeResult> {
  const messages = Array.isArray(opts.body.messages) ? opts.body.messages : []
  const attempts: Attempt[] = []
  let imageIndex = 0
  const rewritten: unknown[] = []
  for (const message of messages) {
    if (!(isRecord(message) && Array.isArray(message.content))) {
      rewritten.push(message)
      continue
    }
    const parts: unknown[] = []
    for (const part of message.content) {
      if (!isImageUrlPart(part)) {
        parts.push(part)
        continue
      }
      imageIndex += 1
      const outcome = await captionOneImage(ctx, {
        bridgeAddress: opts.bridgeAddress,
        url: part.image_url.url,
        signal: opts.signal,
        launchScoped: opts.launchScoped,
      })
      attempts.push(outcome.attempt)
      if (!outcome.ok || outcome.caption === undefined) {
        return {
          ok: false,
          attempts,
          response: jsonError(
            STATUS_BAD_GATEWAY,
            `vision bridge "${opts.bridgeAddress}" failed for image ${imageIndex}: ${outcome.attempt.failure ?? 'unknown error'}`,
          ),
        }
      }
      parts.push({ type: 'text', text: `[Image ${imageIndex}: ${outcome.caption}]` })
    }
    rewritten.push({ ...message, content: parts })
  }
  return { ok: true, attempts, body: { ...opts.body, messages: rewritten } }
}
