/**
 * A launch's keyless upstream: the child's Anthropic-wire traffic, forwarded
 * to the one upstream its launch was routed to, with the provider key added
 * here on the way out. The child holds only a placeholder, so reading its own
 * environment yields a nonce that dies with the launch, never the key.
 *
 * It reaches only that upstream's `base_url`, never `routePost` or a hop, so
 * it needs no agentic refusal. It logs nothing and records no provenance: the
 * agentic hop that launched the child already records the call.
 */

import type { DoorContext } from './doorContext.ts'
import {
  jsonError,
  MAX_JSON_BODY_BYTES,
  readCappedBytes,
  STATUS_BAD_GATEWAY,
  STATUS_FORBIDDEN,
  STATUS_PAYLOAD_TOO_LARGE,
} from './http.ts'
import { errMessage } from './records.ts'
import { resolveUpstream, upstreamUrl } from './upstream.ts'

const LAUNCH_UPSTREAM_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/models'])

function launchUpstreamPathAllowed(rest: string, rawUrl: string): boolean {
  return !/%2f|%2e/i.test(rawUrl) && !rest.includes('..') && LAUNCH_UPSTREAM_PATHS.has(rest)
}

/**
 * Hop-by-hop and length headers Bun recomputes, `accept-encoding` so Bun
 * negotiates and decodes its own, and both credential forms, so the
 * placeholder never leaves this box whichever header the upstream wants.
 */
const DROPPED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'x-api-key',
  'authorization',
]

export async function forwardLaunchUpstream(
  ctx: DoorContext,
  req: Request,
  nonce: string,
  rest: string,
): Promise<Response> {
  const upstreamId = ctx.launchUpstreams.get(nonce)
  if (upstreamId === undefined) {
    return jsonError(STATUS_FORBIDDEN, 'this launch-scoped URL is unknown or has expired')
  }
  if (!launchUpstreamPathAllowed(rest, req.url)) {
    return jsonError(STATUS_FORBIDDEN, 'this launch-scoped URL cannot reach that path')
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let body: Uint8Array | undefined
  if (hasBody) {
    const bytes = await readCappedBytes(req, MAX_JSON_BODY_BYTES, () =>
      jsonError(STATUS_PAYLOAD_TOO_LARGE, 'JSON body too large'),
    )
    if (bytes instanceof Response) {
      return bytes
    }
    body = bytes
  }
  const upstream = ctx.getConfig().upstreams.find((u) => u.id === upstreamId)
  if (upstream === undefined) {
    return jsonError(STATUS_BAD_GATEWAY, `upstream "${upstreamId}" is no longer configured`)
  }
  const resolved = await resolveUpstream(upstream, ctx.doorOpts.secretExec)
  if (!resolved.ok) {
    return jsonError(resolved.status, resolved.error)
  }
  const headers = new Headers(req.headers)
  for (const name of DROPPED_REQUEST_HEADERS) {
    headers.delete(name)
  }
  for (const [name, value] of Object.entries(resolved.endpoint.headers)) {
    headers.set(name, value)
  }
  let res: Response
  try {
    res = await fetch(upstreamUrl(resolved.endpoint.base_url, rest) + new URL(req.url).search, {
      method: req.method,
      headers,
      body,
      signal: req.signal,
      redirect: 'error',
    })
  } catch (err) {
    return jsonError(STATUS_BAD_GATEWAY, errMessage(err))
  }
  // Bun's fetch already decoded the body but keeps `content-encoding`; passed
  // back, the child would decode it a second time.
  const out = new Headers(res.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  return new Response(res.body, { status: res.status, headers: out })
}

/** Ends a launch's window: its nonce and, when it had one, its keyless route. */
export function releaseLaunch(ctx: DoorContext, nonce: string): void {
  ctx.launchNonces.delete(nonce)
  ctx.launchUpstreams.delete(nonce)
}
