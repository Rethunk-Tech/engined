/**
 * Executing one hop of a request: which engine and upstream it lands on, the
 * body shaping every wire needs, and the three ways a hop can be answered —
 * a local llama router, a remote HTTP provider, or an agentic CLI.
 */

/**
 * The door's OpenAI surface is prefixed; llama-server and every remote provider
 * serve those same paths unprefixed. Strip ours before forwarding, or the
 * upstream is asked for a path only this door knows about.
 */
const OPENAI_PREFIX = '/openai'
function enginePath(doorPath: string): string {
  return doorPath.startsWith(`${OPENAI_PREFIX}/`) ? doorPath.slice(OPENAI_PREFIX.length) : doorPath
}

import { execAgentic } from './agenticHop.ts'
import { resolveUpstreamModelId } from './agenticRedirect.ts'
import { type HopExec, type HopResult, parseHop } from './chain.ts'
import { resolveServedRoute, routeEgress } from './dispatch.ts'
import { type DoorContext, getLlamaRouter } from './doorContext.ts'
import {
  CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  jsonErrorBody,
  SSE_CONTENT_TYPE,
  STATUS_BAD_GATEWAY,
  STATUS_FORBIDDEN,
  sseDataPayloads,
  sseFrames,
} from './http.ts'
import { reportedModelFrom } from './llama.ts'
import { parseRecord } from './records.ts'
import { LOCAL_UPSTREAM } from './routeAddress.ts'
import type { Config, Egress, EngineEntry, EngineKind, ResolvedRoute } from './types.ts'
import { resolveUpstream, upstreamPath, upstreamUrl } from './upstream.ts'

/**
 * An explicit `null` from the caller unsets a wire default rather than being
 * forwarded as a null. Without this a caller can override an `[engine.args]`
 * key but never remove one, and a vendor that answers 400 for a parameter is
 * unrecoverable: the caller drops the field from its retry, and engined puts
 * the configured value straight back.
 *
 * Only the caller's own nulls count. A null in `[engine.args]` is the operator
 * saying to send one, which is a different instruction.
 */
function withoutCallerNulls(
  merged: Record<string, unknown>,
  caller: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...merged }
  for (const [key, value] of Object.entries(caller)) {
    if (value === null) {
      delete out[key]
    }
  }
  return out
}

function stripField(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const rest = { ...body }
  delete rest[field]
  return rest
}

/**
 * `rawBody.model` is whatever the caller's own request named -- a chain
 * name, an alias, anything -- never necessarily this hop's resolved model
 * id, so it is overwritten rather than forwarded verbatim. `workdir` and
 * `max_egress` are door-only and stripped; every other caller-supplied
 * field passes through.
 *
 * Shared by the local llama proxy and the remote HTTP proxy: both speak the
 * same OpenAI body, and the only thing that differs is where it is posted
 * and what proves the caller may post it.
 */
function openAiRequestInit(
  rawBody: Record<string, unknown>,
  resolvedModelId: string,
  signal: AbortSignal,
): RequestInit {
  return {
    method: 'POST',
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify({
      ...stripField(stripField(rawBody, 'workdir'), 'max_egress'),
      model: resolvedModelId,
    }),
    signal,
  }
}

/**
 * An engine has no address of its own, so a hop's egress is whichever
 * upstream ITS OWN resolved route names -- never the engine id alone, which
 * a two-upstream engine (`@/claude/anthropic/sonnet-5` and
 * `@/claude/local/ornith`) cannot answer for on its own. Fail-closed
 * `"remote"` when the hop cannot be resolved to a route at all, the same
 * rule every other unresolvable-address case follows.
 */
export function egressOf(ctx: DoorContext, hop: string): Egress {
  const config = ctx.getConfig()
  const { engine: engineId, upstream: upstreamSeg, model } = parseHop(hop)
  const route = resolveServedRoute({
    config,
    engineId,
    modelSeg: model,
    upstreamSeg,
    inventory: ctx.registry.inventory,
  })
  return route === undefined ? 'remote' : routeEgress(route, config)
}

export interface HopRequest {
  pathname: string
  rawBody: Record<string, unknown>
  setContentType: (ct: string) => void
  /** Whether ANY hop of the chain this one belongs to forwards tool-calling fields, which is what makes an agentic hop's refusal advance rather than terminate. */
  toolsHonourableElsewhere: boolean
  /** Whether the caller addressed a chain rather than one engine. Nothing in the hops themselves answers this, and a chain caller owns none of the omissions a single hop's own shape needs. */
  inChain: boolean
}

/** One `openai-http` hop, resolved: the engine answering it, the model segment it was addressed by, and the route (if any) that segment resolved to. */
interface HttpHop {
  engineEntry: EngineEntry
  modelSeg: string
  route: ResolvedRoute | undefined
  req: HopRequest & { signal: AbortSignal }
}

/**
 * The `openai-http` case: proxy through this engine's `LlamaRouter`, `workdir`
 * stripped. `req.signal` is `runOneHop`'s own per-hop timeout/caller-abort --
 * forwarded into `RequestInit` so a slow upstream is actually cut off at the
 * budget `chatTimeoutMs` picked, not just marked aborted after the fact.
 */
async function execLlama(
  ctx: DoorContext,
  { engineEntry, modelSeg, route, req }: HttpHop,
): Promise<HopResult> {
  if (!route) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`model "${modelSeg}" not found on "${engineEntry.id}"`),
    }
  }
  const router = getLlamaRouter(ctx, engineEntry)
  // Both fetchBuffered and fetchStreamed take this same `init`, so
  // rewriting `model` once here fixes both proxy paths.
  const init = openAiRequestInit(req.rawBody, route.model ?? modelSeg, req.signal)
  // `modelResident` comes back with the hop, read under the same lease: from
  // the engine's own /v1/models — never the router's cached command
  // bookkeeping, and never model_reported: the two answer different questions
  // and one silently standing in for the other defeats provenance.
  const { response, modelResident } = await router.proxy(route, enginePath(req.pathname), init)
  const { stream, modelReported } = await readHopBody(response, req.setContentType)
  return {
    status: response.status,
    stream,
    modelReported,
    modelResident,
  }
}

/**
 * The half of a hop's response handling that has nothing to do with which
 * kind of engine answered: pick the content type, hand the caller its bytes
 * untouched, and learn the model the upstream says it used.
 *
 * A buffered JSON response is parsed from a clone, so the caller's own read
 * stays untouched. An SSE body cannot be buffered the same way — those bytes
 * are already owed to the caller as they arrive — so it is teed instead: one
 * branch goes back to the caller unread, the other is sniffed only far
 * enough to find the first `data:` frame's model id.
 */
async function readHopBody(
  response: Response,
  setContentType: (ct: string) => void,
): Promise<{ stream: ReadableStream<Uint8Array> | undefined; modelReported: string | undefined }> {
  const contentType = response.headers.get(CONTENT_TYPE) ?? JSON_CONTENT_TYPE
  setContentType(contentType)
  if (contentType.includes(JSON_CONTENT_TYPE)) {
    // `.clone()` before `.body` is ever touched: reading the getter first
    // disturbs the body Bun's clone() then tees from.
    const modelReported = reportedModelFrom(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    )
    return { stream: response.body ?? undefined, modelReported }
  }
  if (contentType.includes(SSE_CONTENT_TYPE) && response.body) {
    const [forCaller, forSniff] = response.body.tee()
    return { stream: forCaller, modelReported: await firstReportedModel(forSniff) }
  }
  return { stream: response.body ?? undefined, modelReported: undefined }
}

/** The first `data:` line in one SSE frame that parses to an object carrying `model`, if any. */
function reportedModelFromFrame(frame: string): string | undefined {
  for (const data of sseDataPayloads(frame)) {
    const model = reportedModelFrom(parseRecord(data))
    if (model !== undefined) {
      return model
    }
  }
  return undefined
}

/**
 * Reads only as far as the first `data:` frame that parses to an object with
 * a `model` field, then cancels its reader — the tee's other branch keeps
 * flowing to the caller regardless of how much of this one was drained. A
 * stream that never carries one, ends first, or errors mid-read resolves
 * `undefined`: an absent field is honest, a guessed one is not.
 */
async function firstReportedModel(sniff: ReadableStream<Uint8Array>): Promise<string | undefined> {
  try {
    for await (const frame of sseFrames(sniff)) {
      const model = reportedModelFromFrame(frame)
      if (model !== undefined) {
        return model
      }
      if (sseDataPayloads(frame).length > 0) {
        return
      }
    }
  } catch {
    // A sniff-read failure is not the caller's failure: the tee's other
    // branch shares the same underlying source and reports it independently.
  }
  return undefined
}

/**
 * The remote `openai-http` case: the same OpenAI body posted straight at a
 * configured address with the engine's secret in its one header. No router,
 * no occupancy and no `model_resident` — nothing is loaded here, so there is
 * no resident model to report, and inventing one would put a claim in the
 * provenance line that no read backs.
 *
 * `max_egress` is stripped alongside `workdir`: both are engined's own door
 * fields, and a provider that validates its request body strictly rejects
 * the whole call over one it has never heard of.
 */
async function execRemoteHttp(
  ctx: DoorContext,
  { engineEntry, modelSeg, route, req }: HttpHop,
): Promise<HopResult> {
  const config = ctx.getConfig()
  // The route's own upstream carries the address and secret; the engine
  // itself has none of its own.
  const upstream =
    route?.upstream === undefined || route.upstream === null
      ? undefined
      : config.upstreams.find((u) => u.id === route.upstream)
  if (upstream === undefined) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineEntry.id}" has no resolvable upstream`),
    }
  }
  const resolution = await resolveUpstream(upstream, ctx.doorOpts.secretExec)
  if (!resolution.ok) {
    return { status: resolution.status, body: jsonErrorBody(resolution.error) }
  }
  const modelId = resolveUpstreamModelId(config, engineEntry.id, modelSeg, upstream.id)
  if (modelId === undefined) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineEntry.id}" requires a model, and none was named`),
    }
  }
  // [engine.args] are engine-level wire defaults (reasoning_effort, and
  // whatever else this upstream takes) -- the caller's own body wins, the same
  // way a [model.args] key wins over [engine.args] one layer down.
  const callerBody = stripField(req.rawBody, 'max_egress')
  const body = withoutCallerNulls({ ...engineEntry.args, ...callerBody }, callerBody)
  const init = openAiRequestInit(body, modelId, req.signal)
  const response = await fetch(
    upstreamUrl(resolution.endpoint.base_url, upstreamPath(req.pathname)),
    {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...resolution.endpoint.headers },
    },
  )
  const { stream, modelReported } = await readHopBody(response, req.setContentType)
  return { status: response.status, stream, modelReported }
}

export function buildHopExec(ctx: DoorContext, req: HopRequest, launchScoped: boolean): HopExec {
  return async (hop, signal) => {
    const { engine: engineId, upstream: upstreamSeg, model: modelSeg } = parseHop(hop)
    const kind = ctx.registry.get(engineId)?.kind
    // Which of the two openai-http proxies applies is the resolved route's
    // question, not the engine's: `upstream === "local"` is this box's own
    // llama-server, anything else is proxied elsewhere with no local router.
    // Also this hop's provenance `upstream_used` -- absent for an ambient
    // route, which named no upstream at all.
    const route = resolveServedRoute({
      config: ctx.getConfig(),
      engineId,
      modelSeg,
      upstreamSeg,
      inventory: ctx.registry.inventory,
    })
    const upstreamUsed = route?.upstream ?? undefined
    const result = await execHop(ctx, req, {
      engineId,
      modelSeg,
      kind,
      route,
      launchScoped,
      signal,
    })
    return { ...result, upstreamUsed }
  }
}

interface HopDispatch {
  engineId: string
  modelSeg: string
  kind: EngineKind | undefined
  route: ResolvedRoute | undefined
  launchScoped: boolean
  signal: AbortSignal
}

async function execHop(ctx: DoorContext, req: HopRequest, d: HopDispatch): Promise<HopResult> {
  const { engineId, modelSeg, kind, route, launchScoped, signal } = d
  // Keyed on the RESOLVED engine, never the caller's literal model string:
  // a one-segment address that resolves to an agentic route is the same
  // attack as naming that engine outright, and refusing only the literal
  // spelling would miss it. `envelopeFailure: true` is what keeps this a
  // clean terminal refusal rather than advancing: 403 is otherwise one of
  // the credential-shaped statuses `classifyResult` advances past, and this
  // is a proven refusal, not a transport hiccup a next hop might route
  // around.
  if (launchScoped && kind === 'agentic-cli') {
    return {
      status: STATUS_FORBIDDEN,
      envelopeFailure: true,
      body: jsonErrorBody(
        `engine "${engineId}" is agentic and cannot be reached from a launch-scoped door`,
      ),
    }
  }
  if (kind === 'agentic-cli') {
    return await execAgentic(ctx, {
      engineId,
      modelSeg,
      route,
      req: {
        rawBody: req.rawBody,
        signal,
        setContentType: req.setContentType,
        toolsHonourableElsewhere: req.toolsHonourableElsewhere,
        inChain: req.inChain,
      },
    })
  }
  const engineEntry = ctx.registry.entry(engineId)
  if (
    kind === 'openai-http' &&
    engineEntry &&
    route !== undefined &&
    route.upstream !== LOCAL_UPSTREAM
  ) {
    return await execRemoteHttp(ctx, { engineEntry, modelSeg, route, req: { ...req, signal } })
  }
  if (kind === 'openai-http' && engineEntry) {
    return await execLlama(ctx, { engineEntry, modelSeg, route, req: { ...req, signal } })
  }
  return {
    status: STATUS_BAD_GATEWAY,
    body: jsonErrorBody(`engine "${engineId}" of kind "${kind}" cannot serve this request`),
  }
}

/**
 * The budget for one hop, keyed on THAT hop's own engine kind -- never on
 * whether the request happens to be a chain, and never on any other hop
 * sharing it. Both budgets are single top-level values, applied per attempt
 * according to the kind answering it; an all-llama chain must not
 * inherit the long agentic budget just because a chain is, in general,
 * allowed to contain agentic hops.
 */
export function timeoutSecondsForKind(kind: EngineKind | undefined, config: Config): number {
  return kind === 'agentic-cli' ? config.agent_timeout_seconds : config.chat_timeout_seconds
}
